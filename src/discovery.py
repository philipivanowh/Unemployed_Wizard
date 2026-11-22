"""Event discovery loop.

Every DISCOVERY_INTERVAL seconds: for each watched Instagram account, fetch its recent posts,
skip the ones already handled, run the new ones through the parser (OCR + LLMs) and push the
resulting events to the TypeScript backend.

Which posts count as "already handled":
  - posts that became events: the backend keeps that list itself (ingest.py asks for it)
  - posts judged not to be events: remembered in config.SEEN_FILE, so the paid parser calls
    aren't repeated for them every pass

    python src/discovery.py            # run forever (Ctrl+C to stop)
    python src/discovery.py --once     # one pass, then exit (handy for testing / cron)

Settings (WATCHLIST, DISCOVERY_INTERVAL, ...) are in config.py.
Needs the TS backend running and the parser's API keys set (see config.REQUIRED_API_KEYS).
"""
import argparse
import json
import logging
import sys
import time

import config
from ingest import TransientError, get_parser, ingest_posts
from instagram_scrapper.scrapper import InstagramError, fetch_posts

log = logging.getLogger("discovery")


def load_seen():
    """Ids of posts already judged not to be events."""
    try:
        return set(json.loads(config.SEEN_FILE.read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_seen(seen):
    config.SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.SEEN_FILE.write_text(json.dumps(sorted(seen)))


def discover_account(username, seen):
    """Check one account. Returns how many events were created."""
    try:
        result = fetch_posts(username, limit=config.POSTS_PER_ACCOUNT)
    except InstagramError as e:
        # Most likely cause: the access token expired or was revoked.
        log.error("Instagram refused %s (HTTP %s): %s", username, e.status, e.payload)
        return 0
    account = result["username"] or username.strip().lstrip("@").lower()  # one spelling, used for the backend

    candidates = [p for p in result["posts"] if p["id"] not in seen]
    if not candidates:
        log.info("%s: nothing new", account)
        return 0

    # The backend drops the posts it already has events for; the parser handles the rest.
    # stop_on_retry: after one temporary failure (parser busy, backend down) don't pile more
    # slow, paid attempts on top; the remaining posts wait for the next pass.
    try:
        outcome = ingest_posts(candidates, account, stop_on_retry=True)
    except TransientError as e:  # backend down or editing off: nothing was spent
        log.warning("%s: can't ingest right now: %s", account, e)
        return 0

    # Remember posts that can never become events. Posts in `retry` are NOT remembered, so the
    # next pass tries them again, and the ones that became events are now on the backend's list.
    for item in outcome["skipped"]:
        seen.add(item["post_id"])
    save_seen(seen)

    log.info(
        "%s: %d created, %d skipped, %d to retry, %d already uploaded",
        account, len(outcome["created"]), len(outcome["skipped"]), len(outcome["retry"]), outcome["already_uploaded"],
    )
    attempted = sum(len(outcome[k]) for k in ("created", "skipped", "retry")) + outcome["already_uploaded"]
    if attempted < len(candidates):
        log.warning("%s: stopped early after a temporary failure; %d post(s) wait for the next pass",
                    account, len(candidates) - attempted)
    for item in outcome["skipped"] + outcome["retry"]:
        log.debug("  %s: %s", item["permalink"], item["reason"])
    return len(outcome["created"])


def discover_once():
    seen = load_seen()
    total = 0
    for i, username in enumerate(config.WATCHLIST):
        if i:
            time.sleep(config.PAUSE_BETWEEN_ACCOUNTS)
        try:
            total += discover_account(username, seen)
        except Exception:  # never let one account kill the loop
            log.exception("unexpected error while checking %s", username)
    return total


def run_forever():
    while True:
        started = time.time()
        log.info("discovery pass started (%d accounts)", len(config.WATCHLIST))
        created = discover_once()
        log.info("discovery pass done: %d new events", created)
        time.sleep(max(0, config.DISCOVERY_INTERVAL - (time.time() - started)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="run a single pass and exit")
    ap.add_argument("-v", "--verbose", action="store_true", help="also log why posts were skipped")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        get_parser()  # fail fast if the API keys aren't set, rather than on the first post
    except RuntimeError as e:
        sys.exit(f"error: {e}")

    try:
        discover_once() if args.once else run_forever()
    except KeyboardInterrupt:
        log.info("stopped")
