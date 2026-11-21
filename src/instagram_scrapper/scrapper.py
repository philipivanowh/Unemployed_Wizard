import os
import requests
from flask import Flask, jsonify, request

# --- Credentials (set here, or via environment variables) -------------------
IG_USER_ID = os.getenv("IG_USER_ID", "17841466659616214")  # YOUR IG business account ID
ACCESS_TOKEN = os.getenv("IG_ACCESS_TOKEN", "EAAZAuHT9klgMBTPtyLmSXZCVRqaItReuRayBJPMlyC30EB0HAwrHaPuwfkgolVc4ceiAgu8HTWkOvQwLAooG2q8ZBrTMcaRC5f5JLBOpCp17bZCwaQuaOVrOQItiEtjWZBq0J3Weee7uqDafKwe1bmYwT9dI8EJp5eNtl4piyt4PPZAjGEKR9rswCv7bWc4FP43tHwQPZCLukkhtEIIdxame99mXO41NHTRPq5p0HIhjyrSr8pA4ybZAAB4DhDjZAKnTwS5de0sHr9WG2OJ4M")
GRAPH_VERSION = "v27.0"
# -----------------------------------------------------------------------------

app = Flask(__name__)

MEDIA_FIELDS = (
    "id,caption,media_type,media_product_type,permalink,timestamp,"
    "media_url,thumbnail_url,children{media_type,media_url}"
)




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


@app.route("/querry")
@app.route("/query")
def query():
    username = request.args.get("username", "").strip().lstrip("@")
    if not username:
        return jsonify(error="Missing ?username= parameter"), 400

    try:
        limit = max(1, min(int(request.args.get("limit", 5)), 50))
    except ValueError:
        return jsonify(error="limit must be an integer"), 400

    after = request.args.get("after")  # pagination cursor from a previous call
    media = f"media.limit({limit})"
    if after:
        media += f".after({after})"

    fields = f"business_discovery.username({username}){{username,name,{media}{{{MEDIA_FIELDS}}}}}"
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{IG_USER_ID}"

    try:
        r = requests.get(url, params={"fields": fields, "access_token": ACCESS_TOKEN}, timeout=20)
    except requests.RequestException as e:
        return jsonify(error=f"Request to Graph API failed: {e}"), 502

    body = r.json()
    if r.status_code != 200:
        return jsonify(error=body.get("error", body)), r.status_code

    bd = body.get("business_discovery", {})
    media_obj = bd.get("media", {})
    return jsonify(
        username=bd.get("username"),
        name=bd.get("name"),
        posts=[clean_post(m) for m in media_obj.get("data", [])],
        next_cursor=media_obj.get("paging", {}).get("cursors", {}).get("after"),
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)