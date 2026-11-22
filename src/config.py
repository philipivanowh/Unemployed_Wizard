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
POSTS_PER_ACCOUNT = 10

# Posts older than this are about events that are over, so they're never parsed.
MAX_POST_AGE_DAYS = 21

# How many posts are parsed at the same time (OCR and LLM calls mostly wait on the network).
PARSER_WORKERS = 4

# How hard the extraction LLM thinks. Pulling a date and a place out of a post is easy, and
# "high" made every post take much longer.
KIMI_REASONING_EFFORT = "low"

# Seconds to wait between two accounts, to be gentle with the Graph API's rate limits.
PAUSE_BETWEEN_ACCOUNTS = 1

# Where the loop remembers posts it judged NOT to be events (no deal, no date, ...), so it
# doesn't pay to OCR and parse them again. Posts that became events don't need remembering:
# the backend keeps that list (GET /api/instagram/accounts/<username>).
# This is the repo's data/ folder, which is gitignored (the TypeScript database lives there too).
SEEN_FILE = Path(__file__).resolve().parent.parent / "data" / "seen_posts.json"

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
HASHTAGS = ["mcgillfreefood", "mcgillevents", "ssmu"]

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
RECHECK_DAYS = 60
# Active accounts are reread this often, for their @mentions and their food-post rate.
REFRESH_DAYS = 7
# With --retire: an active account goes dormant after this many posts with no food post.
RETIRE_AFTER_POSTS = 40

# Graph API calls one run may make (the discovery loop shares the same rate limit),
# and seconds between them.
MAX_API_CALLS = 150
PAUSE_BETWEEN_CALLS = 2

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
