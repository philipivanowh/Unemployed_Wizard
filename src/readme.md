The scraper is a plain Python library (no web server). Everything on the Python side runs as scripts.

Setup (once):  `pip install -r src/requirements.txt`
Settings (accounts to watch, check interval, ...) are in `src/config.py`.
Secrets come from environment variables:
    MOONSHOT_API_KEY, TYPESAFE_API_KEY, PADDLEOCR_API_KEY   needed by post_parser
    ADMIN_KEY      only if the backend has adding events turned off (the backend's admin key)
    BACKEND_URL    only if the backend isn't at http://localhost:3000

Use the scraper from Python:
    from instagram_scrapper.scrapper import fetch_posts, InstagramError
    fetch_posts("nike", limit=5)   # limit = recent posts to get, don't do more than ~10

fetch_posts returns: username, name, next_cursor, and posts[] with id, timestamp, caption,
media_type, permalink, media_url, thumbnail_url, children. Instagram only gives thumbnail_url for
videos; for photos use media_url (ingest.image_url_for does this for the parser).

Scripts (run with the TypeScript backend up, `npm run dev`):
    python src/discovery.py                run the discovery loop forever (--once = a single pass)
    python src/testing.py scrape nike      print raw scraped posts
    python src/testing.py parse nike       run the parser on one scraped post, nothing is saved
    python src/testing.py uploaded nike    posts the backend already made events from
    python src/testing.py ingest nike      scrape + parse + create events in the backend

The backend remembers which posts became events (events carry instagramAccount and
instagramPostUrl; see "Instagram sources" in the main README), so nothing is uploaded twice.

Accounts to try in the demo: nike, isamcgillu (indian student assoc), mcgillmagicclub
This is still a proof of concept.
