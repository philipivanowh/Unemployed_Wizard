The scraper is a plain Python library (no web server). Everything on the Python side runs as scripts.

Setup (once):  `pip install -r src/requirements.txt`
Settings (accounts to watch, check interval, ...) are in `src/config.py`.
Secrets come from environment variables:  MOONSHOT_API_KEY  (and optionally BACKEND_URL).

Use it from Python:
    from instagram_scrapper.scrapper import fetch_posts, InstagramError
    fetch_posts("nike", limit=5)   # limit = recent posts to get, don't do more than ~10

fetch_posts returns: username, name, next_cursor, and posts[] with id, timestamp, caption,
media_type, permalink, media_url, thumbnail_url, children. media_url / thumbnail_url can be
downloaded directly.

Scripts (run with the TypeScript backend up, `npm run dev`):
    python src/discovery.py               run the discovery loop forever (python src/discovery.py --once = one pass)
    python src/testing.py scrape nike     print raw scraped posts
    python src/testing.py parse nike      run the LLM parser on one scraped post, nothing is saved
    python src/testing.py timestamp nike  show the backend's latest-event timestamp for the account
    python src/testing.py ingest nike     scrape + parse + create events in the backend

Duplicates: the backend keeps the timestamp of the latest Instagram post it has an event for
(GET /api/timestamp?username=nike). The loop drops posts at or before it, and every event we send
carries its post's timestamp and the account's username. If that endpoint errors for any reason,
every recent post is parsed.

Accounts to try in the demo: nike, isamcgillu (indian student assoc), mcgillmagicclub
This is still a proof of concept.
