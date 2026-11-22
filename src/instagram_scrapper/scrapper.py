"""Instagram scraping library. No web framework in here: import it and call fetch_posts().

    from instagram_scrapper.scrapper import fetch_posts, InstagramError
    result = fetch_posts("nike", limit=5)
"""
import os
import requests

# --- Credentials (set here, or via environment variables) -------------------
IG_USER_ID = os.getenv("IG_USER_ID", "17841466659616214")  # YOUR IG business account ID
ACCESS_TOKEN = os.getenv("IG_ACCESS_TOKEN", "EAAZAuHT9klgMBTIRGaqoAX50MA6rH65xZBXtOTRp0qTvrd1F724C9tqsx4pOBIXBhXtCnVA2fepGfgZBYp1MVWZCUoZCYgIEqaYhm53KiZAi7RT4Nt1r5dgM7H3oPfXTWocRufPgInJcMj6aUQBGRkEy87oEBl0vPylJnnQGDRGVBUVNlLqdZCujqHAYZAZBGz4vIMQGKrNkwgVdkp1lk3LPGTkcH1ORSwZCuxSTaQtjm4")
GRAPH_VERSION = "v27.0"
# -----------------------------------------------------------------------------

MEDIA_FIELDS = (
    "id,caption,media_type,media_product_type,permalink,timestamp,"
    "media_url,thumbnail_url,children{media_type,media_url}"
)


class InstagramError(Exception):
    """The Graph API call failed. `status` is the HTTP status to report, `payload` the error body."""

    def __init__(self, status, payload):
        super().__init__(str(payload))
        self.status = status
        self.payload = payload


def clean_post(m):
    return {
        "id": m.get("id"),
        "timestamp": m.get("timestamp"),
        "caption": m.get("caption"),
        "media_type": m.get("media_type"),
        "media_product_type": m.get("media_product_type"),
        "permalink": m.get("permalink"),
        # May be missing (e.g. reels with licensed audio or downloads disabled)
        "media_url": m.get("media_url"),
        "thumbnail_url": m.get("thumbnail_url"),
        # For carousels: the individual photos/videos
        "children": (m.get("children") or {}).get("data", []),
    }


def graph_get(path, params):
    """GET a Graph API path with our access token. Raises InstagramError on failure."""
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{path}"
    try:
        r = requests.get(url, params={**params, "access_token": ACCESS_TOKEN}, timeout=20)
    except requests.RequestException as e:
        raise InstagramError(502, f"Request to Graph API failed: {e}")
    try:
        body = r.json()
    except ValueError:
        raise InstagramError(r.status_code, r.text[:300])
    if r.status_code != 200:
        raise InstagramError(r.status_code, body.get("error", body))
    return body


def fetch_posts(username, limit=5, after=None):
    """Recent posts of a business/creator account.

    Returns {"username", "name", "posts": [...], "next_cursor"}.
    Raises ValueError for bad arguments and InstagramError if the Graph API fails.
    """
    username = (username or "").strip().lstrip("@")
    if not username:
        raise ValueError("Missing username")
    try:
        limit = max(1, min(int(limit), 50))
    except (TypeError, ValueError):
        raise ValueError("limit must be an integer")

    media = f"media.limit({limit})"
    if after:  # pagination cursor from a previous call
        media += f".after({after})"

    fields = f"business_discovery.username({username}){{username,name,{media}{{{MEDIA_FIELDS}}}}}"
    body = graph_get(IG_USER_ID, {"fields": fields})

    bd = body.get("business_discovery", {})
    media_obj = bd.get("media", {})
    return {
        "username": bd.get("username"),
        "name": bd.get("name"),
        "posts": [clean_post(m) for m in media_obj.get("data", [])],
        "next_cursor": media_obj.get("paging", {}).get("cursors", {}).get("after"),
    }


def fetch_profile(username, limit=25):
    """Profile and recent captions of a business/creator account: a lighter call than
    fetch_posts (no image URLs), for deciding whether an account is worth watching.

    Returns {"username", "name", "biography", "followers_count", "posts": [{id, caption, permalink, timestamp}]}.
    """
    username = (username or "").strip().lstrip("@")
    if not username:
        raise ValueError("Missing username")
    limit = max(1, min(int(limit), 50))
    fields = (f"business_discovery.username({username})"
              f"{{username,name,biography,followers_count,media.limit({limit}){{id,caption,permalink,timestamp}}}}")
    bd = graph_get(IG_USER_ID, {"fields": fields}).get("business_discovery", {})
    return {
        "username": bd.get("username"),
        "name": bd.get("name"),
        "biography": bd.get("biography"),
        "followers_count": bd.get("followers_count"),
        "posts": (bd.get("media") or {}).get("data", []),
    }


def hashtag_posts(tag, edges=("recent_media", "top_media"), limit=50):
    """Posts using a hashtag (recent_media only covers the last 24 hours).

    Needs the app's "Instagram Public Content Access" feature, and Instagram allows only 30
    different hashtags per account per 7 days. The posts don't say who made them.
    """
    found = graph_get("ig_hashtag_search", {"user_id": IG_USER_ID, "q": tag.lstrip("#")}).get("data") or []
    if not found:
        return []
    posts = []
    for edge in edges:
        body = graph_get(f"{found[0]['id']}/{edge}",
                         {"user_id": IG_USER_ID, "fields": "id,caption,permalink,timestamp", "limit": limit})
        posts.extend(body.get("data", []))
    return posts
