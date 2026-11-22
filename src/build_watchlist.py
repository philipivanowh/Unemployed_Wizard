"""Finds Instagram accounts that post free food events and adds them to the watchlist.

Where candidate accounts come from:
  backend    accounts the backend already has events from (e.g. typed into the Add Event form)
  --add      accounts you name on the command line
  mentions   @accounts that watched accounts mention, mentions in food posts first: co-hosts
             and sponsors of a food event tend to post food events too
  directory  instagram.com links on club directory pages (config.DIRECTORY_PAGES)
  hashtags   @mentions in posts using config.HASHTAGS

Each candidate is then vetted with one Graph API call: its recent captions are read, and it's
added if enough of them offer free food, it posted recently, and it mentions McGill or Montreal
(see config.py for the thresholds and word lists). Accounts from the backend or --add only have
to be readable (business or creator accounts). The mentions of every account that gets added
join the queue as well, so the list grows outward from accounts that work.

Watched accounts aren't fetched again: their @mentions and food-post rate come from the posts
the discovery loop already fetched (config.RECENT_POSTS_FILE). With --retire, accounts that
stopped posting food are retired.

Kept deliberately slow, because Meta cancels tokens that look like scrapers: each run makes at
most config.MAX_API_CALLS calls and adds at most config.MAX_NEW_ACCOUNTS_PER_RUN accounts, runs
at most once every config.MIN_HOURS_BETWEEN_RUNS hours, and stops adding at
config.MAX_WATCHED_ACCOUNTS. All Graph API calls also share the limits in throttle.py.

    python src/build_watchlist.py                 # one run
    python src/build_watchlist.py --dry-run       # show what would change, save nothing
    python src/build_watchlist.py --add club1 club2
    python src/build_watchlist.py --retire
    python src/build_watchlist.py --list          # print the watchlist and exit

Results go to config.WATCHLIST_FILE. The discovery loop rereads it on every pass, so both can
run at the same time. Candidates a run doesn't get to wait for the next one. Within
MIN_HOURS_BETWEEN_RUNS, --add still works but only checks the accounts you name.
"""
import argparse
import copy
import heapq
import itertools
import logging
import math
import re
import sys
import time
from datetime import datetime, timezone

import requests

import config
import watchlist
from instagram_scrapper.scrapper import InstagramError, fetch_profile, hashtag_posts
from watchlist import normalize

log = logging.getLogger("build_watchlist")

# Queue order: lower is vetted first.
P_TRUSTED, P_FOOD_MENTION, P_DIRECTORY, P_MENTION = 0, 1, 2, 3
TRUSTED_SOURCES = {"backend", "--add"}

# Instagram usernames: up to 30 letters, digits, periods and underscores, not ending in a period.
USERNAME = r"[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?"
USERNAME_RE = re.compile(USERNAME)
MENTION_RE = re.compile(rf"(?<![\w.@])@({USERNAME})(?!\w)", re.I)  # not the middle of an email address
LINK_RE = re.compile(rf"instagram\.com/({USERNAME})(?!\w)", re.I)
NOT_ACCOUNTS = {"p", "reel", "reels", "tv", "explore", "accounts", "stories", "about", "developer",
                "legal", "direct", "web", "static", "privacy", "terms", "sharer", "share", "embed"}



def _words(words):
    """One regex for a word list: words match whole, emoji anywhere."""
    parts = [rf"(?<!\w){re.escape(w.lower())}(?!\w)" if re.search(r"\w", w) else re.escape(w) for w in words]
    return re.compile("|".join(parts) if parts else r"(?!)")


FOOD_RE = _words(config.FOOD_WORDS)
FREE_RE = _words(config.FREE_WORDS)
FOOD_TAG_RE = _words(config.FOOD_TAGS)
LOCAL_RE = _words(config.LOCAL_WORDS)


def is_food_post(caption):
    text = (caption or "").lower()
    return bool(FOOD_TAG_RE.search(text) or (FOOD_RE.search(text) and FREE_RE.search(text)))


def mentions(text):
    return [m.lower() for m in MENTION_RE.findall(text or "")]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def days_since(stamp):
    """Days since an ISO time (Instagram's "2026-11-20T18:00:00+0000" included); inf if unknown."""
    if not stamp:
        return math.inf
    try:
        when = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        try:
            when = datetime.fromisoformat(stamp)
        except ValueError:
            return math.inf
    return (datetime.now(timezone.utc) - when).total_seconds() / 86400


class StopRun(Exception):
    """Out of API calls, or an error that would hit every call (token, rate limit)."""


def short_error(error):
    return error.message[:200]


class Builder:
    def __init__(self, accounts, max_calls, retire):
        self.accounts = accounts
        self.calls_left = min(max_calls, config.MAX_API_CALLS)
        self.added = 0
        self.forced = set()  # named with --add
        self.calls_made = 0
        self.retire = retire
        self.seeds = {normalize(u) for u in config.WATCHLIST}
        self.ignored = {normalize(u) for u in config.IGNORED_ACCOUNTS}
        self.queue = []  # (priority, order, username)
        self.order = itertools.count()
        self.found_via = {}  # username -> sources this run
        self.done = set()  # vetted or refreshed this run
        self.changes = []  # (username, old status, new status, reason)

    # --- Graph API, within the budget ----------------------------------------

    def call(self, fn, *args, cost=1, **kwargs):
        if self.calls_left < cost:
            raise StopRun(f"used all {self.calls_made} API calls allowed per run (config.MAX_API_CALLS)")
        # No sleeping here: graph_get waits its turn under the shared limits (throttle.py).
        self.calls_left -= cost
        self.calls_made += cost
        try:
            return fn(*args, **kwargs)
        except InstagramError as e:
            if e.fatal:  # token, rate limit or connection: not this account's fault
                raise StopRun(f"Instagram stopped us (HTTP {e.status}): {short_error(e)}")
            raise

    # --- candidates ----------------------------------------------------------

    def is_due(self, username):
        """Should this account be vetted? New ones yes; rejected ones again after RECHECK_DAYS."""
        if username in self.seeds or username in self.done:
            return False
        entry = self.accounts.get(username)
        if entry is None:
            return True
        if entry.get("status") == "active":
            return False
        return days_since(entry.get("checked_at")) >= config.RECHECK_DAYS

    def offer(self, username, source, priority, force=False):
        u = normalize(username)
        if not USERNAME_RE.fullmatch(u) or u in self.ignored or u in NOT_ACCOUNTS:
            return
        self.found_via.setdefault(u, set()).add(source)
        if force:
            self.forced.add(u)
        if force or self.is_due(u):
            heapq.heappush(self.queue, (priority, next(self.order), u))

    def offer_mentions(self, profile_user, posts):
        for post in posts:
            priority = P_FOOD_MENTION if is_food_post(post.get("caption")) else P_MENTION
            for m in mentions(post.get("caption")):
                if m != profile_user:
                    self.offer(m, f"@{profile_user}", priority)

    def from_backend(self):
        try:
            r = requests.get(f"{config.BACKEND_URL}/api/instagram/accounts", timeout=15)
            r.raise_for_status()
            names = [a["username"] for a in r.json()["accounts"]]
        except (requests.RequestException, ValueError, KeyError) as e:
            log.warning("skipping the backend's accounts (is it running?): %s", e)
            return
        for name in names:
            self.offer(name, "backend", P_TRUSTED)
        log.info("backend: %d account(s) with events", len(names))

    def from_directories(self):
        for page in config.DIRECTORY_PAGES:
            try:
                r = requests.get(page, timeout=20, headers={"User-Agent": "Mozilla/5.0 (watchlist builder)"})
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("couldn't read %s: %s", page, e)
                continue
            names = {m.lower() for m in LINK_RE.findall(r.text)} - NOT_ACCOUNTS
            for name in names:
                self.offer(name, "directory", P_DIRECTORY)
            log.info("directory: %d account(s) linked from %s", len(names), page)

    def from_hashtags(self):
        for tag in config.HASHTAGS:
            try:
                posts = self.call(hashtag_posts, tag, cost=3)  # search + 2 lists
            except InstagramError as e:
                log.warning("hashtag search unavailable, skipping hashtags: %s", short_error(e))
                return
            before = len(self.queue)
            for post in posts:
                priority = P_FOOD_MENTION if is_food_post(post.get("caption")) else P_MENTION
                for m in mentions(post.get("caption")):
                    self.offer(m, f"#{tag}", priority)
            log.info("#%s: %d post(s), %d new candidate(s)", tag, len(posts), len(self.queue) - before)

    # --- reading an account --------------------------------------------------

    def look(self, username, limit):
        """One Graph API call. Returns (profile, stats), or (None, reason) if it can't be read."""
        try:
            profile = self.call(fetch_profile, username, limit=limit)
        except InstagramError as e:
            return None, f"can't be read (private, personal, renamed or gone): {short_error(e)}"
        return profile, self.stats_for(profile)

    @staticmethod
    def stats_for(profile):
        posts = profile["posts"]
        texts = [profile.get("name") or "", profile.get("biography") or ""] + [p.get("caption") or "" for p in posts]
        stats = {
            "name": profile.get("name"),
            "followers": profile.get("followers_count"),
            "posts_checked": len(posts),
            "food_posts": sum(is_food_post(p.get("caption")) for p in posts),
            "last_post_at": max((p["timestamp"] for p in posts if p.get("timestamp")), default=None),
            "checked_at": now_iso(),
        }
        stats["local"] = any(LOCAL_RE.search(t.lower()) for t in texts)
        if stats["name"] is None:
            del stats["name"], stats["followers"]  # not known from cached posts: keep the old values
        return stats

    def record(self, username, status, reason, stats=None, sources=()):
        old = self.accounts.get(username, {})
        entry = {**old, **(stats or {}), "status": status, "reason": reason}
        entry.pop("local", None)
        entry["sources"] = sorted(set(old.get("sources", [])) | set(sources))
        entry.setdefault("added_at", now_iso())
        if stats is None:
            entry["checked_at"] = now_iso()
        self.accounts[username] = entry
        if old.get("status") != status:
            self.changes.append((username, old.get("status"), status, reason))

    def judge(self, stats, trusted):
        n, food = stats["posts_checked"], stats["food_posts"]
        if trusted:
            return "active", f"{'/'.join(sorted(trusted))}; {food} food posts in its last {n}"
        if not n:
            return "rejected", "no posts"
        if days_since(stats["last_post_at"]) > config.MAX_INACTIVE_DAYS:
            return "rejected", f"no posts since {stats['last_post_at'][:10]}"
        if config.REQUIRE_LOCAL and not stats["local"]:
            return "rejected", "doesn't mention McGill or Montreal"
        if food < config.MIN_FOOD_POSTS:
            return "rejected", f"{food} food post(s) in its last {n}"
        return "active", f"{food} food posts in its last {n}"

    def vet(self, username):
        self.done.add(username)
        sources = self.found_via.get(username, set())
        profile, stats = self.look(username, config.VET_POSTS)
        if profile is None:
            self.record(username, "unavailable", stats, sources=sources)
            return
        status, reason = self.judge(stats, sources & TRUSTED_SOURCES)
        self.record(username, status, reason, stats, sources)
        log.info("%-30s %-8s %s", username, status, reason)
        if status == "active":
            self.added += 1
            self.offer_mentions(username, profile["posts"])

    def refresh_watched(self):
        """Update watched accounts from the posts the discovery loop already fetched, without any
        API call: their @mentions join the queue, and their food-post rate is recorded."""
        cache = watchlist.recent_posts()
        watched = sorted(self.seeds | {u for u, a in self.accounts.items() if a.get("status") == "active"})
        for username in watched:
            cached = cache.get(username)
            entry = self.accounts.get(username, {})
            if not cached or entry.get("refreshed_from") == cached.get("fetched_at"):
                continue  # nothing new since last time
            self.done.add(username)
            posts = cached.get("posts", [])
            self.offer_mentions(username, posts)
            stats = {**self.stats_for({"posts": posts}), "refreshed_from": cached.get("fetched_at")}
            n, food = stats["posts_checked"], stats["food_posts"]
            if username in self.seeds:
                self.record(username, "active", "in config.WATCHLIST", stats, ["config"])
            elif self.retire and n >= config.RETIRE_AFTER_POSTS and food == 0:
                self.record(username, "retired", f"no food posts in its last {n}", stats)
            elif self.retire and days_since(stats["last_post_at"]) > config.MAX_INACTIVE_DAYS:
                self.record(username, "retired", f"no posts since {(stats['last_post_at'] or '?')[:10]}", stats)
            else:
                self.record(username, "active", entry.get("reason", ""), stats)
            log.debug("%-30s refreshed from cache: %d food posts in its last %d", username, food, n)

    def watched_found(self):
        return sum(1 for u, a in self.accounts.items() if a.get("status") == "active" and u not in self.seeds)

    # --- a run ---------------------------------------------------------------

    def run(self, added, discover=True):
        """discover=False: only check the accounts named with --add."""
        for name in added:
            self.offer(name, "--add", P_TRUSTED, force=True)
        if discover:
            self.from_backend()
            self.from_directories()
            self.refresh_watched()
            self.from_hashtags()
        while self.queue:
            _, _, username = heapq.heappop(self.queue)
            if username in self.done:
                continue
            if username not in self.forced:
                if not discover:
                    continue
                if self.added >= config.MAX_NEW_ACCOUNTS_PER_RUN:
                    raise StopRun(f"added {self.added} accounts, the most per run (config.MAX_NEW_ACCOUNTS_PER_RUN)")
                if self.watched_found() >= config.MAX_WATCHED_ACCOUNTS:
                    raise StopRun(f"the watchlist is full ({config.MAX_WATCHED_ACCOUNTS} found accounts, "
                                  "config.MAX_WATCHED_ACCOUNTS); use --retire or raise the limit")
            self.vet(username)


def print_list(accounts):
    seeds = [normalize(u) for u in config.WATCHLIST]
    rows = [(u, accounts.get(u, {"status": "active", "reason": "in config.WATCHLIST"})) for u in seeds]
    rows += sorted(((u, a) for u, a in accounts.items() if u not in seeds),
                   key=lambda r: (r[1].get("status") != "active", -(r[1].get("food_posts") or 0), r[0]))
    for u, a in rows:
        rate = f"{a.get('food_posts', '?')}/{a.get('posts_checked', '?')}"
        print(f"{a.get('status', '?'):<12} {rate:>6}  {u:<30} {a.get('reason', '')}")
    counts = {}
    for _, a in rows:
        counts[a.get("status")] = counts.get(a.get("status"), 0) + 1
    print("\n" + ", ".join(f"{n} {s}" for s, n in sorted(counts.items(), key=lambda x: str(x[0]))))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--add", nargs="+", default=[], metavar="ACCOUNT", help="vet these accounts now and add them if readable")
    ap.add_argument("--retire", action="store_true", help="retire active accounts that stopped posting food")
    ap.add_argument("--dry-run", action="store_true", help="show what would change without saving")
    ap.add_argument("--max-calls", type=int, default=config.MAX_API_CALLS,
                    help="Graph API calls this run may make (at most config.MAX_API_CALLS)")
    ap.add_argument("--list", action="store_true", help="print the watchlist and exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):  # account names and captions contain emoji
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    saved = watchlist.load()
    if args.list:
        print_list(saved)
        return

    # Once a day at most: a run that keeps looking up new accounts is what gets tokens cancelled.
    hours = days_since(watchlist.last_run_at()) * 24
    discover = hours >= config.MIN_HOURS_BETWEEN_RUNS
    if not discover:
        wait = config.MIN_HOURS_BETWEEN_RUNS - hours
        if not args.add:
            print(f"The watchlist was last built {hours:.1f} h ago; the next run is allowed in {wait:.1f} h "
                  f"(config.MIN_HOURS_BETWEEN_RUNS). Use --add to check specific accounts now.")
            return
        log.info("last run %.1f h ago: only checking the accounts given with --add", hours)

    builder = Builder(copy.deepcopy(saved), args.max_calls, args.retire)
    try:
        builder.run(args.add, discover)
    except StopRun as e:
        log.warning("stopping early: %s", e)
    except KeyboardInterrupt:
        log.warning("interrupted; keeping what was found so far")
    finally:
        if not args.dry_run:
            watchlist.save(builder.accounts, last_run=now_iso() if discover else None)

    added = [c for c in builder.changes if c[2] == "active"]
    print(f"\n{len(added)} account(s) added, {builder.calls_made} API call(s) used"
          + (", nothing saved (--dry-run)" if args.dry_run else f", saved to {config.WATCHLIST_FILE}"))
    for username, old, new, reason in builder.changes:
        print(f"  {old or 'new':<11} -> {new:<11} {username:<30} {reason}")
    waiting = len({u for _, _, u in builder.queue} - builder.done)
    if waiting:
        print(f"{waiting} candidate(s) left for the next run")


if __name__ == "__main__":
    main()
