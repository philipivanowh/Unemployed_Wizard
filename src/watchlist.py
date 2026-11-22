"""The saved watchlist: accounts build_watchlist.py found, and what it learned about them.

config.WATCHLIST_FILE (data/watchlist.json) looks like:

    {"accounts": {"someclub": {
        "status": "active",          # active | rejected | unavailable | retired
        "reason": "4 food posts in its last 30",
        "sources": ["@otherclub", "directory"],   # where it was found
        "name": "Some Club", "followers": 812,
        "posts_checked": 30, "food_posts": 4, "last_post_at": "2026-11-20T18:00:00+00:00",
        "checked_at": "...", "added_at": "..."}}}

Only "active" accounts are checked by the discovery loop. The others are remembered so they
aren't looked at again before config.RECHECK_DAYS.
"""
import json
import os
import time

import config


def normalize(username):
    return (username or "").strip().lstrip("@").lower()


def load():
    """{username: entry}. An unreadable file counts as empty."""
    try:
        data = json.loads(config.WATCHLIST_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data.get("accounts", {})


def save(accounts):
    path = config.WATCHLIST_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"accounts": dict(sorted(accounts.items()))}, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    # Replace in one step, so the discovery loop never reads a half-written file. On Windows this
    # fails while the loop has the file open (only for an instant), so try a few times.
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.5)


def active_usernames():
    """What the discovery loop checks: config.WATCHLIST, then the saved active accounts,
    the ones with the most food posts first."""
    seeds = [normalize(u) for u in config.WATCHLIST]
    saved = load()
    found = sorted((u for u, a in saved.items() if a.get("status") == "active" and u not in seeds),
                   key=lambda u: -(saved[u].get("food_posts") or 0))
    return list(dict.fromkeys(seeds + found))
