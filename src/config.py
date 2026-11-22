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

# Where the loop remembers which posts it already handled. This is the repo's data/ folder,
# which is gitignored (the TypeScript database lives there too).
SEEN_FILE = Path(__file__).resolve().parent.parent / "data" / "seen_posts.json"

# --- Backend and LLM ---------------------------------------------------------

# The TypeScript (Express) server that stores the events.
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")

# Key for the Moonshot LLM used by post_parser. Set it in your shell, don't write it here:
#   export MOONSHOT_API_KEY=...        (PowerShell: $env:MOONSHOT_API_KEY="...")
MOONSHOT_API_KEY = os.getenv("MOONSHOT_API_KEY", "")
