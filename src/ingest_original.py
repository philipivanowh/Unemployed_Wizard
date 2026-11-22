"""Turns scraped Instagram posts into events in the TypeScript backend.

    posts -> drop the ones the backend already has -> PostParser (LLM) -> to_event() -> POST /api/events

Used by discovery.py (the loop) and testing.py (manual checks). Settings are in config.py.

Duplicate protection: the backend remembers the timestamp of the latest Instagram post it has
an event for (GET /api/timestamp?username=...). Posts at or before that moment are dropped; and
every event we send carries its post's timestamp (and account), so that value stays up to date.
"""
import json
import re
from datetime import datetime, timezone

import openai
import requests

import config
from post_parser.post_parser import PostParser


class TransientError(Exception):
    """Something that may work if tried again later (backend down, LLM unreachable).
    A post that fails this way must NOT be remembered as 'done'."""


# --- Timestamps ---------------------------------------------------------------


def parse_timestamp(value):
    """Read a timestamp into an aware UTC datetime. Raises ValueError if it can't.

    Accepts Instagram's format ('2026-11-20T10:00:00+0000'), ISO 8601 ('...Z', '...+00:00',
    or a bare date/time, taken as UTC) and Unix epoch seconds or milliseconds.
    """
    if isinstance(value, bool):
        raise ValueError("not a timestamp")
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e11 else value  # milliseconds vs seconds
        return datetime.fromtimestamp(seconds, tz=timezone.utc)

    text = str(value).strip()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return parse_timestamp(float(text))
    text = re.sub(r"Z$", "+00:00", text)
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)  # +0000 -> +00:00 (older Pythons need the colon)
    parsed = datetime.fromisoformat(text)  # raises ValueError on garbage
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_timestamp(moment):
    """The form we send to the backend: ISO 8601 in UTC, e.g. 2026-11-20T10:00:00Z."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_latest_timestamp(username):
    """Ask the backend for the timestamp of the latest event it has for this Instagram account.

    Returns (moment, note). `moment` is an aware datetime, or None if there's no usable answer:
    ANY problem (backend unreachable, HTTP error, bad JSON, no events yet, unreadable value)
    counts as "no latest timestamp", so every post then gets parsed. `note` says what happened.
    """
    try:
        r = requests.get(f"{config.BACKEND_URL}/api/timestamp", params={"username": username}, timeout=10)
    except requests.RequestException as e:
        return None, f"backend unreachable: {e}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}: {r.text[:200]}"
    try:
        body = r.json()
    except ValueError:
        return None, f"response was not JSON: {r.text[:200]}"

    raw = body.get("timestamp") if isinstance(body, dict) else body  # {"timestamp": ...} or a bare value
    if raw is None or raw == "":
        return None, "the backend has no timestamp for this account yet"
    try:
        return parse_timestamp(raw), f"backend returned {raw!r}"
    except ValueError as e:
        return None, f"could not read timestamp {raw!r}: {e}"


def select_new_posts(posts, latest):
    """Drop posts the backend already covers (posted at or before `latest`), oldest first.

    `latest=None` keeps everything. A post whose own timestamp can't be read is kept, since we
    can't prove it's old. Returns (posts_to_process, number_dropped).

    Oldest first matters: the backend's timestamp only moves forward, so a post must never be
    processed *after* a newer one succeeded, or a temporary failure would lose it for good.
    """
    dated = []
    for post in posts:
        try:
            moment = parse_timestamp(post["timestamp"])
        except (KeyError, ValueError, TypeError):
            moment = None
        dated.append((moment, post))

    kept = [(m, p) for m, p in dated if latest is None or m is None or m > latest]
    kept.sort(key=lambda mp: mp[0] or datetime.max.replace(tzinfo=timezone.utc))  # unreadable ones last
    return [p for _, p in kept], len(posts) - len(kept)


# --- LLM -----------------------------------------------------------------------

_parser = None


def get_parser():
    """Built on first use, so scraping still works without a Moonshot key."""
    global _parser
    if _parser is None:
        if not config.MOONSHOT_API_KEY:
            raise RuntimeError("Set the MOONSHOT_API_KEY environment variable to parse posts")
        _parser = PostParser(config.MOONSHOT_API_KEY)
    return _parser


def parse_post(post):
    """Ask the LLM about one scraped post and return its raw answer (a string).

    The one place that talks to the LLM, so the loop and testing.py behave identically.
    Raises TransientError if the LLM can't be reached.
    """
    try:
        return get_parser().parse_text(post["caption"])
    except openai.OpenAIError as e:
        raise TransientError(f"LLM call failed: {e}")


def extract_json(text):
    """The LLM may wrap its answer in ```json fences or add chatter; grab the {...} part."""
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        raise ValueError("no JSON object in the model's answer")
    return json.loads(match.group(0))


# --- Backend -------------------------------------------------------------------


def to_event(parsed, post, username):
    """Map the parser's output onto the TypeScript API's schema (see src/events/validation.ts).

    Also attaches where the event came from: the Instagram account and the post's timestamp.
    """
    required = ("title", "date", "start_time", "address_line_1")
    missing = [k for k in required if not parsed.get(k)]
    if missing:
        raise ValueError(f"parser left out required fields: {', '.join(missing)}")

    address = ", ".join(x for x in (parsed["address_line_1"], parsed.get("address_line_2")) if x)
    event = {
        "title": parsed["title"][:120],
        "date": parsed["date"],  # must be YYYY-MM-DD
        "startTime": parsed["start_time"],  # must be 24h HH:MM
        "endTime": parsed.get("end_time"),
        "address": address,
        # The parser has no list of items yet and the API needs at least one.
        "freeItems": [parsed["title"][:100]],
        "description": parsed.get("description") or "",
        # Provenance, for the backend's /api/timestamp. NOTE: these two field names are our
        # agreement with the backend; change them here if the backend calls them something else.
        "username": username,
    }
    try:
        event["timestamp"] = format_timestamp(parse_timestamp(post["timestamp"]))
    except (KeyError, ValueError, TypeError):
        pass  # Instagram always sends one; if not, the event is still created, just without it
    return event


def post_event(event):
    """Create the event in the TS backend.

    Raises TransientError if the backend is unreachable or has a server error,
    and ValueError if it rejected the event (bad data; retrying won't help).
    """
    try:
        r = requests.post(f"{config.BACKEND_URL}/api/events", json=event, timeout=30)
    except requests.RequestException as e:
        raise TransientError(f"backend unreachable: {e}")
    if r.status_code >= 500:
        raise TransientError(f"backend error {r.status_code}")
    if r.status_code != 201:
        raise ValueError(f"backend said {r.status_code}: {r.text[:300]}")
    return r.json()


def ingest_posts(posts, username, stop_on_retry=False):
    """Run scraped posts (as returned by fetch_posts) through the pipeline, in the order given.

    `username` is the Instagram account they came from. Returns three lists:
      created  posts that became events
      skipped  posts that can never become events (no caption, no date, rejected...)
      retry    posts that failed for a temporary reason; try them again next time

    With stop_on_retry, the first temporary failure ends the run and the remaining posts are
    left untouched (not in any list), so no newer post gets ahead of a failed older one.
    """
    get_parser()  # fail fast (RuntimeError) if the API key is missing, before touching any post
    created, skipped, retry = [], [], []
    for post in posts:
        info = {"post_id": post["id"], "permalink": post["permalink"]}
        try:
            if not post["caption"]:
                raise ValueError("post has no caption")
            event = to_event(extract_json(parse_post(post)), post, username)
            created.append({**info, "event": post_event(event)})
        except TransientError as e:
            retry.append({**info, "reason": str(e)})
            if stop_on_retry:
                break
        except Exception as e:  # one bad post shouldn't stop the others
            skipped.append({**info, "reason": str(e)})
    return {"created": created, "skipped": skipped, "retry": retry}
