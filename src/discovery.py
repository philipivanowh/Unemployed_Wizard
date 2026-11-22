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

Settings (WATCHLIST, DISCOVERY_INTERVAL, ...) are in config.py. Besides config.WATCHLIST it checks
the accounts build_watchlist.py saved in config.WATCHLIST_FILE.
Needs the TS backend running and the parser's API keys set (see config.REQUIRED_API_KEYS).
"""
import argparse
import json
import logging
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import config
import watchlist
from ingest import (TransientError, check_edit_access, get_parser, is_recent, post_age_days,
                    process_post, shortcode_of, uploaded_shortcodes)
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


def collect_posts(accounts, seen):
    """Scrape the accounts and return [(account, post)] still worth parsing: recent, not judged
    before, and not already an event. Calls are spaced out by the shared Graph API limits
    (instagram_scrapper/throttle.py). If Instagram or those limits say stop, the accounts not
    reached yet wait for the next pass. Raises TransientError if the backend can't be asked."""
    jobs, fetched = [], {}
    try:
        for done_count, username in enumerate(accounts):
            try:
                result = fetch_posts(username, limit=config.POSTS_PER_ACCOUNT)
            except InstagramError as e:
                if e.fatal:
                    log.error("stopped scraping after %d of %d accounts (HTTP %s, code %s): %s",
                              done_count, len(accounts), e.status, e.code, e.message.rstrip("."))
                    break
                log.warning("%s: can't be read (HTTP %s): %s", username, e.status, e.message)
                continue
            account = result["username"] or username.strip().lstrip("@").lower()  # one spelling, used for the backend
            jobs += [(account, p) for p in _worth_parsing(account, result["posts"], seen)]
            fetched[account.lower()] = result["posts"]
    finally:
        watchlist.remember_posts(fetched)  # build_watchlist.py reuses these instead of calling again
    # Newest first: the likeliest to be about events that haven't happened yet.
    return sorted(jobs, key=lambda job: post_age_days(job[1]))


def _worth_parsing(account, posts, seen):
    fresh = [p for p in posts if p["id"] not in seen and is_recent(p)]
    if fresh:  # only ask the backend when there's something to filter
        done = uploaded_shortcodes(account)
        fresh = [p for p in fresh if shortcode_of(p["permalink"]) not in done]
    log.info("%s: %d post(s) fetched, %d new and recent", account, len(posts), len(fresh))
    return fresh


def discover_once():
    """One pass over the watchlist. Returns how many events were created."""
    seen = load_seen()
    accounts = watchlist.active_usernames()  # reread every pass: build_watchlist.py may have added some
    # Shuffled, so that when the Graph API limits cut a pass short it isn't always the same
    # accounts that miss out.
    random.shuffle(accounts)
    log.info("discovery pass started (%d accounts)", len(accounts))
    started = time.time()
    try:
        check_edit_access()  # before any paid call: would the backend accept the events?
        jobs = collect_posts(accounts, seen)
    except InstagramError as e:
        log.error("Instagram refused every request (HTTP %s, code %s): %s. Skipping this pass; if it's the "
                  "token, set a new one in IG_ACCESS_TOKEN.", e.status, e.code, e.message.rstrip("."))
        return 0
    except TransientError as e:  # backend down or editing off: nothing was spent
        log.warning("can't ingest right now: %s", e)
        return 0
    log.info("scraped in %.0fs; parsing %d post(s), %d at a time", time.time() - started, len(jobs), config.PARSER_WORKERS)

    # After one temporary failure (OCR service busy, backend down) don't start more slow, paid
    # attempts; the posts not started yet wait for the next pass.
    stop = threading.Event()

    def work(job):
        if stop.is_set():
            return "deferred", {}
        outcome, info = process_post(job[1], job[0])
        if outcome == "retry":
            stop.set()
        return outcome, info

    counts = {"created": 0, "skipped": 0, "retry": 0, "deferred": 0}
    with ThreadPoolExecutor(max_workers=config.PARSER_WORKERS) as pool:
        futures = {pool.submit(work, job): job for job in jobs}
        for future in as_completed(futures):
            account, post = futures[future]
            outcome, info = future.result()
            counts[outcome] += 1
            if outcome == "created":
                log.info("%s: created event %s from %s", account, info["event"].get("id"), post["permalink"])
            elif outcome == "skipped":
                # Can never become an event: remember it so it's never paid for again.
                seen.add(info["post_id"])
                save_seen(seen)
                log.info("%s: skipped %s: %s", account, post["permalink"], info["reason"])
            elif outcome == "retry":
                log.warning("%s: will retry %s: %s", account, post["permalink"], info["reason"])

    log.info("discovery pass done in %.0fs: %d created, %d skipped, %d to retry, %d left for the next pass",
             time.time() - started, counts["created"], counts["skipped"], counts["retry"], counts["deferred"])
    return counts["created"]


def run_forever():
    while True:
        started = time.time()
        discover_once()
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
