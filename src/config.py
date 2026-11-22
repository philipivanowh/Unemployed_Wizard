"""Settings for the Python side (scraper, parser, discovery loop). Edit this file to change them.

Secrets and per-machine settings come from environment variables instead (see the bottom).
"""
import os
from pathlib import Path

# --- Discovery loop (discovery.py) -------------------------------------------

# Instagram accounts to check for events, without the @.
# They must be business or creator accounts (a Graph API limitation).
WATCHLIST = [
    "mcgillmagicclub",
    "isamcgillu",
]

# How often the loop checks every account, in seconds.
DISCOVERY_INTERVAL = 6 * 60 * 60  # every 6 hours

# How many of an account's most recent posts to look at on each check.
POSTS_PER_ACCOUNT = 10

# Seconds to wait between two accounts, to be gentle with the Graph API's rate limits.
PAUSE_BETWEEN_ACCOUNTS = 5

# Where the loop remembers posts it judged NOT to be events (no deal, no date, ...), so it
# doesn't pay to OCR and parse them again. Posts that became events don't need remembering:
# the backend keeps that list (GET /api/instagram/accounts/<username>).
# This is the repo's data/ folder, which is gitignored (the TypeScript database lives there too).
SEEN_FILE = Path(__file__).resolve().parent.parent / "data" / "seen_posts.json"

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
