"""Manual checks for the Python side. Run from the repo root (or anywhere):

    python src/testing.py scrape USERNAME [--limit 5]      raw scraped posts, as JSON
    python src/testing.py parse  USERNAME [--index 0]      run the LLM parser on ONE scraped post
    python src/testing.py timestamp USERNAME               the backend's latest-event timestamp for an account
    python src/testing.py ingest USERNAME [--limit 5]      full pipeline for one account (creates events!)

`parse` and `timestamp` are safe: they send nothing to the backend that changes it.
`ingest` applies the same latest-timestamp filter as the discovery loop, but not the loop's
"seen posts" list, so it can still re-send a post the loop had skipped.
"""
import argparse
import json
import sys

import config
from ingest import (extract_json, fetch_latest_timestamp, format_timestamp, ingest_posts,
                    parse_post, select_new_posts, to_event)
from instagram_scrapper.scrapper import InstagramError, fetch_posts


def show(title, body):
    print(f"\n=== {title}\n{body}")


def scrape(username, limit=5):
    """Print the raw posts fetched for an account."""
    result = fetch_posts(username, limit=limit)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def test_parser(username, index=0):
    """Run the post_parser LLM on one scraped post and show what comes out at every stage.

    1. the post's caption      2. the LLM's raw answer
    3. the JSON extracted from it      4. the event that would be sent to the backend
    Nothing is sent to the backend. Returns that event, or None if the post would be skipped.
    """
    result = fetch_posts(username, limit=index + 1)
    posts, account = result["posts"], result["username"] or username
    if index >= len(posts):
        print(f"{username} only has {len(posts)} post(s) available; --index {index} is out of range.")
        return None
    post = posts[index]

    show("POST", f"{post['permalink']}\nposted {post['timestamp']}")
    if not post["caption"]:
        print("(no caption, so the pipeline would skip this post without calling the LLM)")
        return None
    show("CAPTION", post["caption"])

    answer = parse_post(post)  # same call the discovery loop makes
    show("LLM RAW ANSWER", answer)

    try:
        parsed = extract_json(answer)
    except ValueError as e:  # includes json.JSONDecodeError
        show("RESULT", f"could not read the answer as JSON: {e}")
        return None
    show("PARSED JSON", json.dumps(parsed, indent=2, ensure_ascii=False))

    try:
        event = to_event(parsed, post, account)
    except ValueError as e:
        show("RESULT", f"post would be SKIPPED: {e}")
        return None
    show("RESULT: would be sent to the backend as", json.dumps(event, indent=2, ensure_ascii=False))
    return event


def check_timestamp(username):
    """Show what the backend says is the latest event timestamp for an Instagram account.

    This is the value discovery.py uses to drop posts it already has events for.
    Returns the timestamp as an aware datetime, or None if the backend gave no usable answer.
    """
    account = username.strip().lstrip("@").lower()
    latest, note = fetch_latest_timestamp(account)
    show(f"LATEST TIMESTAMP for {account}", f"asked: {config.BACKEND_URL}/api/timestamp?username={account}\n{note}")
    if latest is None:
        print("-> no usable timestamp: discovery would parse EVERY recent post of this account")
    else:
        print(f"-> {format_timestamp(latest)}: discovery would drop posts at or before this moment")
    return latest


def ingest(username, limit=5):
    """Scrape an account and push its new events to the backend, then print what happened."""
    result = fetch_posts(username, limit=limit)
    account = result["username"] or username
    latest, note = fetch_latest_timestamp(account)
    posts, dropped = select_new_posts(result["posts"], latest)
    print(f"latest timestamp: {format_timestamp(latest) if latest else 'none (' + note + ')'}; "
          f"dropped {dropped} already-ingested post(s), processing {len(posts)}", file=sys.stderr)
    outcome = ingest_posts(posts, account)
    print(json.dumps(outcome, indent=2, ensure_ascii=False))
    return outcome


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scrape", help="print raw scraped posts")
    p.add_argument("username")
    p.add_argument("--limit", type=int, default=5)

    p = sub.add_parser("parse", help="run the LLM parser on one scraped post")
    p.add_argument("username")
    p.add_argument("--index", type=int, default=0, help="which post, 0 = the most recent (default)")

    p = sub.add_parser("timestamp", help="show the backend's latest-event timestamp for an account")
    p.add_argument("username")

    p = sub.add_parser("ingest", help="scrape + parse + create events in the backend")
    p.add_argument("username")
    p.add_argument("--limit", type=int, default=5)

    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):  # captions contain emoji, which Windows consoles choke on
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        if args.command == "scrape":
            scrape(args.username, args.limit)
        elif args.command == "parse":
            test_parser(args.username, args.index)
        elif args.command == "timestamp":
            check_timestamp(args.username)
        else:
            ingest(args.username, args.limit)
    except InstagramError as e:
        sys.exit(f"Instagram error (HTTP {e.status}): {e.payload}")
    except (ValueError, RuntimeError) as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
