"""Manual checks for the Python side. Run from the repo root (or anywhere):

    python src/testing.py scrape   USERNAME [--limit 5]    raw scraped posts, as JSON
    python src/testing.py parse    USERNAME [--index 0]    run the parser (OCR + LLMs) on ONE scraped post
    python src/testing.py uploaded USERNAME                posts the backend already made events from
    python src/testing.py ingest   USERNAME [--limit 5]    full pipeline for one account (creates events!)

`parse` and `uploaded` are safe: they change nothing in the backend. `parse` does spend real
OCR and LLM calls, though. `ingest` skips posts the backend already has, like the discovery loop
does, but not the loop's own list of posts judged not to be events, so it may re-parse those.
"""
import argparse
import json
import sys

import config
from ingest import (TransientError, extract_json, image_url_for, ingest_posts, parse_post,
                    to_event, uploaded_post_urls)
from instagram_scrapper.scrapper import InstagramError, fetch_posts


def show(title, body):
    print(f"\n=== {title}\n{body}")


def scrape(username, limit=5):
    """Print the raw posts fetched for an account."""
    result = fetch_posts(username, limit=limit)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def test_parser(username, index=0):
    """Run post_parser on one scraped post and show what comes out at every stage.

    1. the post's caption and image      2. the parser's raw answer
    3. the JSON read from it             4. the event that would be sent to the backend
    Nothing is sent to the backend. Returns that event, or None if the post would be skipped.
    """
    result = fetch_posts(username, limit=index + 1)
    posts, account = result["posts"], result["username"] or username
    if index >= len(posts):
        print(f"{username} only has {len(posts)} post(s) available; --index {index} is out of range.")
        return None
    post = posts[index]

    show("POST", f"{post['permalink']}\nposted {post['timestamp']}")
    image = image_url_for(post)
    show("IMAGE the parser will read", image or "(none)")
    show("CAPTION", post["caption"] or "(none)")
    if not post["caption"] and not image:
        print("\nthe pipeline would skip this post: it has neither a caption nor an image")
        return None

    try:
        answer = parse_post(post)  # same call the discovery loop makes
    except TransientError as e:
        show("RESULT", f"the parser failed (the loop would retry this post later): {e}")
        return None
    show("PARSER RAW ANSWER", answer)

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


def check_uploaded(username):
    """Show the posts the backend says it already made events from. The discovery loop skips these."""
    account = username.strip().lstrip("@").lower()
    urls = uploaded_post_urls(account)
    show(f"UPLOADED POSTS for {account}", f"asked: {config.BACKEND_URL}/api/instagram/accounts/{account}")
    print("\n".join(urls) if urls else "(none yet: every recent post of this account would be parsed)")
    return urls


def ingest(username, limit=5):
    """Scrape an account and push its new events to the backend, then print what happened."""
    result = fetch_posts(username, limit=limit)
    outcome = ingest_posts(result["posts"], result["username"] or username)
    print(json.dumps(outcome, indent=2, ensure_ascii=False))
    return outcome


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scrape", help="print raw scraped posts")
    p.add_argument("username")
    p.add_argument("--limit", type=int, default=5)

    p = sub.add_parser("parse", help="run the parser on one scraped post")
    p.add_argument("username")
    p.add_argument("--index", type=int, default=0, help="which post, 0 = the most recent (default)")

    p = sub.add_parser("uploaded", help="show the posts the backend already made events from")
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
        elif args.command == "uploaded":
            check_uploaded(args.username)
        else:
            ingest(args.username, args.limit)
    except InstagramError as e:
        sys.exit(f"Instagram error (HTTP {e.status}): {e.payload}")
    except TransientError as e:
        sys.exit(f"can't do that right now: {e}")
    except (ValueError, RuntimeError) as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
