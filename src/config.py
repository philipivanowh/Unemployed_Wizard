"""Settings for the Python side (scraper, parser, discovery loop). Edit this file to change them.

Secrets and per-machine settings come from environment variables instead (see the bottom).
"""
import os
from pathlib import Path

# --- Discovery loop (discovery.py) -------------------------------------------

# Instagram accounts to check for events, without the @.
# They must be business or creator accounts (a Graph API limitation).
# build_watchlist.py adds more accounts in WATCHLIST_FILE (below); these are always checked.
WATCHLIST = [
   "mcgillmagicclub",
   "isamcgillu",
     "wherethefoodat.tracker",
     "mcgillcsus",
     "mcgillfoodcoalition",  # McGill Food Coalition (only 1 post as of 2026-11; check it's their main account)
]

# How often the loop checks every account, in seconds.
DISCOVERY_INTERVAL = 6 * 60 * 60  # every 6 hours

# How many of an account's most recent posts to look at on each check. Fetching more is free
# (still one API call); only new, recent posts are parsed.
POSTS_PER_ACCOUNT = 4

# Posts older than this are about events that are over, so they're never parsed.
MAX_POST_AGE_DAYS = 21

# How many posts are parsed at the same time (OCR and LLM calls mostly wait on the network).
PARSER_WORKERS = 4

# How hard the extraction LLM thinks. Pulling a date and a place out of a post is easy, and
# "high" made every post take much longer.
KIMI_REASONING_EFFORT = "low"

# The spacing between accounts comes from the Graph API limits below.

# Where the loop remembers posts it judged NOT to be events (no deal, no date, ...), so it
# doesn't pay to OCR and parse them again. Posts that became events don't need remembering:
# the backend keeps that list (GET /api/instagram/accounts/<username>).
# This is the repo's data/ folder, which is gitignored (the TypeScript database lives there too).
SEEN_FILE = Path(__file__).resolve().parent.parent / "data" / "seen_posts.json"

# --- Graph API limits (every script, see instagram_scrapper/throttle.py) ------
#
# Meta cancels tokens for "suspicious activity": bursts of calls, many different accounts looked
# up quickly, and calling again after being refused. These limits apply to all scripts together
# (the discovery loop, build_watchlist.py, testing.py), and survive restarts.

GRAPH_LEDGER_FILE = Path(__file__).resolve().parent.parent / "data" / "graph_api_calls.json"

# At least this many seconds between two calls, plus up to 50% random jitter.
GRAPH_MIN_SECONDS_BETWEEN_CALLS = 20
# Hard caps. Meta's own limit is around 200 calls per hour; stay far below it.
GRAPH_MAX_CALLS_PER_HOUR = 60
GRAPH_MAX_CALLS_PER_DAY = 400
# Meta reports how much of its limits we use in response headers. Past this percentage, stop.
GRAPH_USAGE_COOLDOWN_PERCENT = 50
# How long every call stops after: high usage, a rate-limit error, or a refused token. A
# "blocked" cooldown ends early when IG_ACCESS_TOKEN is replaced.
GRAPH_COOLDOWN_HOURS = {"usage": 1, "rate_limit": 6, "blocked": 24}
# A script waits this long at most for its turn, then gives up until its next run.
GRAPH_MAX_WAIT_SECONDS = 15 * 60

# --- Building the watchlist (build_watchlist.py) -----------------------------
#
# build_watchlist.py finds more accounts to watch and saves them to WATCHLIST_FILE. The
# discovery loop checks WATCHLIST above plus every "active" account in that file, and
# rereads the file on every pass, so the two scripts can run at the same time.

WATCHLIST_FILE = Path(__file__).resolve().parent.parent / "data" / "watchlist.json"

# Web pages to collect instagram.com/<account> links from (club directories).
DIRECTORY_PAGES = [
    "https://ssmu.ca/clubs/religion-culture-clubs/",
    "https://ssmu.ca/clubs/athletics-recreation-clubs/",
    "https://ssmu.ca/clubs/political-socialactivism-clubs/",
    "https://ssmu.ca/clubs/community-outreach-and-volunteering-clubs/",
    "https://ssmu.ca/clubs/networking-and-leadership-development-clubs/",
    "https://www.mcgill.ca/morsl/connect/clubs",
]

# Hashtags whose posts are searched for @mentions. Needs the Graph API's "Instagram Public
# Content Access" feature (the script carries on without it), and Instagram allows only
# 30 different hashtags per 7 days, so keep this list short.
# Off by default: hashtag search is a separate permission and an easy way to look like a scraper.
HASHTAGS = []

# Accounts never to add (brands, news pages, ...), without the @.
IGNORED_ACCOUNTS = ["mcgillu", "instagram"]

# A caption is a "food post" when it has a word from FOOD_WORDS and one from FREE_WORDS.
# Matched case-insensitively on word boundaries; phrases are fine.
FOOD_WORDS = [
    "food", "pizza", "snack", "snacks", "lunch", "dinner", "breakfast", "brunch", "coffee",
    "tea", "bubble tea", "donut", "donuts", "doughnuts", "cookies", "cake", "bagels", "tacos",
    "sandwiches", "burgers", "poutine", "ice cream", "refreshments", "drinks", "bbq",
    "bouffe", "nourriture", "repas", "collation", "collations", "café", "dîner", "déjeuner",
    "🍕", "🍩", "🍪", "☕", "🥪", "🌮", "🍔", "🧋", "🍦", "🥯", "🍰", "🍟",
]
FREE_WORDS = [
    "free", "complimentary", "provided", "on us", "will be served", "no cost",
    "gratuit", "gratuite", "gratuits", "gratuites", "offert", "offerte", "offerts", "fournie",
]

# Hashtags that make a food post on their own (whole words, so "#freefood" counts).
FOOD_TAGS = ["freefood", "freepizza", "freesnacks", "freecoffee", "freelunch", "bouffegratuite"]

# An account counts as local if its name, bio or captions mention one of these.
LOCAL_WORDS = ["mcgill", "ssmu", "aéum", "aeum", "montreal", "montréal", "mtl", "milton-parc", "downtown"]
REQUIRE_LOCAL = True

# How a candidate account is judged: its VET_POSTS most recent captions are read, and it is
# added if MIN_FOOD_POSTS of them are food posts and it posted in the last MAX_INACTIVE_DAYS.
VET_POSTS = 30
MIN_FOOD_POSTS = 2
MAX_INACTIVE_DAYS = 180

# Rejected accounts are looked at again after this many days (clubs change).
RECHECK_DAYS = 90
# With --retire: an active account goes dormant after this many posts with no food post.
# Watched accounts are never re-fetched by build_watchlist.py: it reuses the posts the discovery
# loop already fetched (RECENT_POSTS_FILE).
RETIRE_AFTER_POSTS = 40
RECENT_POSTS_FILE = Path(__file__).resolve().parent.parent / "data" / "recent_posts.json"

# Limits on finding new accounts. Each candidate costs one Graph API call, and looking up many
# accounts you don't follow is what looks most like scraping, so this grows the list slowly.
MAX_API_CALLS = 5  # per run; --max-calls can only lower it
MAX_NEW_ACCOUNTS_PER_RUN = 1  # stop once this many have been added
MIN_HOURS_BETWEEN_RUNS = 24  # a second run sooner exits without calling anything
MAX_WATCHED_ACCOUNTS = 50  # never add past this many found accounts: it bounds every discovery pass

# --- Backend and LLM ---------------------------------------------------------

# The TypeScript (Express) server that stores the events.
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")

# The backend's admin key. Only needed if adding events is turned off there (publicEditing off);
# it's sent as the X-Admin-Key header. It's the ADMIN_KEY environment variable the backend reads.
ADMIN_KEY = os.getenv("ADMIN_KEY", "")

# post_parser reads these API keys itself from the environment (so they never live in code).
# Set them in your shell, e.g.   export MOONSHOT_API_KEY=...    (PowerShell: $env:MOONSHOT_API_KEY="...")
#   MOONSHOT_API_KEY   the LLM that extracts the event details
#   TYPESAFE_API_KEY   the model that decides whether a post is a deal at all
#   PADDLEOCR_API_KEY  reads the text printed on the post's image
REQUIRED_API_KEYS = ("MOONSHOT_API_KEY", "TYPESAFE_API_KEY", "PADDLEOCR_API_KEY")
