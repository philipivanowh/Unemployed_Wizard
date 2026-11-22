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


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    # Replace in one step, so another script never reads a half-written file. On Windows this
    # fails while the other script has the file open (only for an instant), so try a few times.
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.5)


def load():
    """{username: entry}. An unreadable file counts as empty."""
    return _read(config.WATCHLIST_FILE).get("accounts", {})


def last_run_at():
    """When build_watchlist.py last ran (ISO time), or None."""
    return _read(config.WATCHLIST_FILE).get("last_run_at")


def save(accounts, last_run=None):
    data = {"accounts": dict(sorted(accounts.items()))}
    data["last_run_at"] = last_run or last_run_at()
    _write(config.WATCHLIST_FILE, data)


# --- posts the discovery loop already fetched ---------------------------------
# build_watchlist.py reads these for watched accounts' @mentions and food-post rates instead of
# fetching the same accounts from the Graph API again.

RECENT_POSTS_KEPT = 50


def remember_posts(fetched):
    """fetched: {username: [post, ...]}, merged into config.RECENT_POSTS_FILE (newest kept)."""
    if not fetched:
        return
    cache = _read(config.RECENT_POSTS_FILE)
    now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    for username, posts in fetched.items():
        old = {p["id"]: p for p in cache.get(username, {}).get("posts", [])}
        for p in posts:
            old[p["id"]] = {"id": p["id"], "caption": p.get("caption"), "timestamp": p.get("timestamp")}
        newest = sorted(old.values(), key=lambda p: p.get("timestamp") or "", reverse=True)[:RECENT_POSTS_KEPT]
        cache[username] = {"fetched_at": now, "posts": newest}
    _write(config.RECENT_POSTS_FILE, cache)


def recent_posts():
    """{username: {"fetched_at", "posts": [{id, caption, timestamp}]}}"""
    return _read(config.RECENT_POSTS_FILE)


def active_usernames():
    """What the discovery loop checks: config.WATCHLIST, then at most config.MAX_WATCHED_ACCOUNTS
    saved active accounts, the ones with the most food posts first."""
    seeds = [normalize(u) for u in config.WATCHLIST]
    saved = load()
    found = sorted((u for u, a in saved.items() if a.get("status") == "active" and u not in seeds),
                   key=lambda u: -(saved[u].get("food_posts") or 0))
    return list(dict.fromkeys(seeds + found[:config.MAX_WATCHED_ACCOUNTS]))
