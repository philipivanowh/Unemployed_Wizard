"""Event discovery loop.

Every DISCOVERY_INTERVAL seconds: for each watched Instagram account, fetch its recent posts,
drop the ones already covered (older than the backend's latest-event timestamp, or in our seen
list), run the rest through the parser and push the resulting events to the TypeScript backend.

    python src/discovery.py            # run forever (Ctrl+C to stop)
    python src/discovery.py --once     # one pass, then exit (handy for testing / cron)

Settings (WATCHLIST, DISCOVERY_INTERVAL, ...) are in config.py.
Needs the TS backend running and MOONSHOT_API_KEY set.
"""
import argparse
import json
import logging
import sys
import time

import config
from ingest import fetch_latest_timestamp, format_timestamp, ingest_posts, select_new_posts #, get_parser
from instagram_scrapper.scrapper import InstagramError, fetch_posts

log = logging.getLogger("discovery")


def load_seen():
    """Ids of posts we've already handled, so the LLM isn't paid twice for the same caption."""
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

    # 1. Ask the backend how far it has already got. If that fails for ANY reason we act as if
    #    this account has no events yet, and every post is parsed.
    latest, note = fetch_latest_timestamp(account)
    if latest is None:
        log.warning("%s: no usable latest timestamp (%s); parsing every recent post", account, note)
    else:
        log.info("%s: latest event so far is from %s", account, format_timestamp(latest))

    # 2. Keep only new posts, oldest first: not in our seen list, and newer than the latest timestamp.
    unseen = [p for p in result["posts"] if p["id"] not in seen]
    new_posts, dropped = select_new_posts(unseen, latest)
    if dropped:
        log.info("%s: dropped %d post(s) already covered by the latest timestamp", account, dropped)
    if not new_posts:
        log.info("%s: nothing new", account)
        return 0

    # 3. Parse and send. A temporary failure stops this account for now (see ingest_posts).
    outcome = ingest_posts(new_posts, account, stop_on_retry=True)

    # Remember everything that reached a verdict. Posts in `retry` (backend or LLM
    # temporarily down) are NOT remembered, so the next pass tries them again.
    for item in outcome["created"] + outcome["skipped"]:
        seen.add(item["post_id"])
    save_seen(seen)

    attempted = sum(len(outcome[k]) for k in ("created", "skipped", "retry"))
    log.info(
        "%s: %d created, %d skipped, %d to retry",
        account, len(outcome["created"]), len(outcome["skipped"]), len(outcome["retry"]),
    )
    if attempted < len(new_posts):
        log.warning("%s: stopped early after a temporary failure; %d newer post(s) wait for the next pass",
                    account, len(new_posts) - attempted)
    for item in outcome["skipped"]:
        log.debug("  skipped %s: %s", item["permalink"], item["reason"])
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
        pass
    #    get_parser()  # fail fast if MOONSHOT_API_KEY isn't set, rather than on the first post
    except RuntimeError as e:
        sys.exit(f"error: {e}")

    try:
        discover_once() if args.once else run_forever()
    except KeyboardInterrupt:
        log.info("stopped")
