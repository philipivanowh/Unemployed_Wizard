"""Turns scraped Instagram posts into events in the TypeScript backend.

    posts -> drop the ones the backend already has -> PostParser.evaluate_post (OCR + LLMs)
          -> to_event() -> POST {BACKEND_URL}/api/events

Used by discovery.py (the loop) and testing.py (manual checks). Settings are in config.py.
"""
import json
import logging
import os
import re
import threading
from datetime import date, datetime, timezone
from urllib.parse import quote

import requests

import config

log = logging.getLogger("ingest")


class TransientError(Exception):
    """Something that may work if tried again later (backend down, editing turned off, a parser
    or API hiccup). A post that fails this way must NOT be remembered as 'done'."""


# --- the parser --------------------------------------------------------------

_local = threading.local()  # one parser per thread: discovery.py parses several posts at once


def get_parser():
    """Built on first use. Raises RuntimeError, naming what's missing, if API keys aren't set."""
    if getattr(_local, "parser", None) is None:
        missing = [key for key in config.REQUIRED_API_KEYS if not os.environ.get(key)]
        if missing:
            raise RuntimeError("Set these environment variables to use the parser: " + ", ".join(missing))
        # Imported here so that scraping alone works without the parser's heavy dependencies.
        from post_parser.post_parser import PostParser

        _local.parser = PostParser(kimi_reasoning_effort=config.KIMI_REASONING_EFFORT)
    return _local.parser


def post_age_days(post):
    """How long ago the post was published, in days (Instagram's "2026-11-20T18:00:00+0000")."""
    try:
        when = datetime.strptime(post.get("timestamp") or "", "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return 0.0  # unknown: treat as new rather than silently dropping it
    return (datetime.now(timezone.utc) - when).total_seconds() / 86400


def is_recent(post):
    """Older posts are about events that are over; not worth paying to parse."""
    return post_age_days(post) <= config.MAX_POST_AGE_DAYS


def image_url_for(post):
    """The image the parser should OCR.

    Instagram only provides `thumbnail_url` for videos. For a photo (the usual event poster)
    it's None and the picture is `media_url`, so fall back to that, then to a carousel's first photo.
    """
    if post.get("thumbnail_url"):
        return post["thumbnail_url"]
    if post.get("media_type") != "VIDEO" and post.get("media_url"):
        return post["media_url"]
    for child in post.get("children") or []:
        if child.get("media_type") == "IMAGE" and child.get("media_url"):
            return child["media_url"]
    return None


def parse_post(post):
    """Run one scraped post through post_parser (OCR on its image + the LLMs) and return its
    raw answer, a JSON string. The one place that calls the parser, so the loop and
    testing.py behave identically.

    The parser makes several network calls and can fail in many ways, so any failure is reported
    as a TransientError and the post is simply tried again on the next pass.
    """
    parser = get_parser()  # RuntimeError (missing keys) is deliberately not caught below
    post_info = {
        "timestamp": post["timestamp"],
        "thumbnail_url": image_url_for(post),
        "caption": post["caption"],
    }
    try:
        return parser.evaluate_post(post_info)
    except Exception as e:
        raise TransientError(f"parser failed: {type(e).__name__}: {e}")


# --- reading the parser's answer ---------------------------------------------


def extract_json(text):
    """The answer may be wrapped in ```json fences or chatter, and the parser's own
    'not a deal' answer ends in a trailing comma (invalid JSON), so repair that too."""
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        raise ValueError("no JSON object in the parser's answer")
    raw = match.group(0)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", raw))


def is_deal(parsed):
    """is_deal can come back as true, "true", false..."""
    return str(parsed.get("is_deal")).strip().lower() == "true"


def normalize_date(value):
    """'2026-11-5' or '2026/11/05' -> '2026-11-05'. None if it isn't a real date."""
    match = re.fullmatch(r"\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*", str(value or ""))
    if not match:
        return None
    try:
        return date(*map(int, match.groups())).isoformat()
    except ValueError:
        return None


def normalize_time(value):
    """The backend wants 24-hour HH:MM. Accepts '9:00', '18:00:00', '6 PM', '6:30pm', '18h30', '24:00'."""
    match = re.fullmatch(r"\s*(\d{1,2})(?:[:h.](\d{2})?)?(?::\d{2})?\s*(?:([ap])\.?\s*m?\.?)?\s*",
                         str(value or ""), re.I)
    if not match:
        return None
    hour, minute, half = int(match[1]), int(match[2] or 0), (match[3] or "").lower()
    if half == "p" and hour < 12:
        hour += 12
    elif half == "a" and hour == 12:
        hour = 0
    if (hour, minute) == (24, 0):
        hour, minute = 23, 59
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def to_event(parsed, post, username):
    """Map the parser's answer onto the TypeScript API's schema (see src/events/validation.ts),
    tagging it with the Instagram post it came from. Raises ValueError if it can't be an event."""
    if not is_deal(parsed):
        raise ValueError("not a deal (is_deal is false)")

    # `location` (e.g. "Trottier") is the fallback when there's no street address.
    address = ", ".join(x for x in (parsed.get("address_line_1"), parsed.get("address_line_2")) if x) or parsed.get("location")
    day, start = normalize_date(parsed.get("date")), normalize_time(parsed.get("start_time"))
    fields = {"title": parsed.get("title"), "date": day, "start_time": start, "address": address}
    missing = [name for name, value in fields.items() if not value]
    if missing:
        raw = {k: parsed.get(k) for k in ("date", "start_time")}
        raise ValueError(f"parser left out or garbled required fields: {', '.join(missing)} (got {raw})")
    if day < date.today().isoformat():
        raise ValueError(f"event already happened ({day})")

    description = parsed.get("description") or ""
    if parsed.get("conditions"):
        description = (description + "\n\n" if description else "") + f"Conditions: {parsed['conditions']}"

    return {
        "title": parsed["title"][:120],
        "date": day,  # YYYY-MM-DD
        "startTime": start,  # 24h HH:MM
        "endTime": normalize_time(parsed.get("end_time")),
        "address": address[:300],
        # The parser has no list of items and the API needs at least one.
        "freeItems": [parsed["title"][:100]],
        "description": description[:5000],
        "instagramAccount": username,  # lets the backend remember which posts it has handled
        "instagramPostUrl": post["permalink"],
    }


# --- talking to the backend --------------------------------------------------


def _backend(method, path, **kwargs):
    headers = {"X-Admin-Key": config.ADMIN_KEY} if config.ADMIN_KEY else {}
    try:
        r = requests.request(method, f"{config.BACKEND_URL}{path}", headers=headers, timeout=30, **kwargs)
    except requests.RequestException as e:
        raise TransientError(f"backend unreachable: {e}")
    if r.status_code >= 500:
        raise TransientError(f"backend error {r.status_code}")
    return r


def check_edit_access():
    """Fail before spending money on OCR and LLM calls if the backend wouldn't accept the events."""
    r = _backend("GET", "/api/settings")
    if r.status_code != 200:
        raise TransientError(f"GET /api/settings answered {r.status_code}; is the backend up to date?")
    if not r.json().get("canEdit"):
        raise TransientError("the backend has adding events turned off; set the ADMIN_KEY environment variable to its admin key")


def shortcode_of(url):
    """'C1abcDEF' from https://www.instagram.com/p/C1abcDEF/ (same for /reel/ and /tv/ links)."""
    match = re.search(r"instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", url or "")
    return match.group(1) if match else None


def uploaded_post_urls(username):
    """Links to the account's posts that the backend already made events from (newest first)."""
    r = _backend("GET", f"/api/instagram/accounts/{quote(username, safe='')}")
    if r.status_code != 200:
        raise TransientError(f"asking the backend for {username}'s uploaded posts failed ({r.status_code})")
    return r.json()["postUrls"]


def uploaded_shortcodes(username):
    return {shortcode_of(url) for url in uploaded_post_urls(username)}


def post_event(event):
    """Create the event in the backend. Raises TransientError if it can't be done right now
    (unreachable, server error, editing off), and ValueError if the event itself was rejected."""
    r = _backend("POST", "/api/events", json=event)
    if r.status_code == 201:
        return r.json()
    if r.status_code == 403:
        raise TransientError("the backend refused (403): adding events is turned off; set ADMIN_KEY")
    if r.status_code == 409:  # someone else uploaded this post between our check and now
        raise ValueError("already uploaded (409)")
    raise ValueError(f"backend said {r.status_code}: {r.text[:300]}")


# --- the pipeline ------------------------------------------------------------


def process_post(post, username):
    """Parse one post and create its event. Thread-safe.

    Returns (outcome, info): outcome is "created" (info has "event"), "skipped" (can never become
    an event) or "retry" (temporary failure); info always has "post_id", "permalink" and, unless
    created, "reason".
    """
    info = {"post_id": post["id"], "permalink": post["permalink"]}
    try:
        if not post["caption"] and not image_url_for(post):
            raise ValueError("post has neither a caption nor an image")
        answer = parse_post(post)
        log.debug("parser answer for %s: %s", post["permalink"], answer)
        event = to_event(extract_json(answer), post, username)
        return "created", {**info, "event": post_event(event)}
    except TransientError as e:
        return "retry", {**info, "reason": str(e)}
    except Exception as e:  # one bad post shouldn't stop the others
        return "skipped", {**info, "reason": str(e) if isinstance(e, ValueError) else f"{type(e).__name__}: {e}"}


def ingest_posts(posts, username, stop_on_retry=False):
    """Run an account's scraped posts (as returned by fetch_posts) through the pipeline,
    in the order given.

    Returns {"created", "skipped", "retry", "already_uploaded"}:
      created           posts that became events
      skipped           posts that can never become events (no deal, no date, rejected...)
      retry             posts that failed for a temporary reason; try them again next time
      already_uploaded  how many posts the backend already had (not touched, not parsed)

    With stop_on_retry, the first temporary failure ends the run and the posts after it are left
    untouched (in no list). The parser can wait minutes when its OCR service is busy, so after one
    temporary failure it's wiser to stop than to repeat that wait for every remaining post.

    Raises RuntimeError if the parser's API keys are missing, and TransientError if the backend
    can't be used right now. Both happen before any paid call is made.
    """
    get_parser()
    check_edit_access()
    done = uploaded_shortcodes(username)
    todo = [p for p in posts if shortcode_of(p["permalink"]) not in done]

    results = {"created": [], "skipped": [], "retry": []}
    for post in todo:
        outcome, info = process_post(post, username)
        results[outcome].append(info)
        if outcome == "retry" and stop_on_retry:
            break
    created, skipped, retry = results["created"], results["skipped"], results["retry"]
    return {"created": created, "skipped": skipped, "retry": retry, "already_uploaded": len(posts) - len(todo)}
