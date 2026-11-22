import { db } from "./db.ts";

// Instagram posts that have been parsed and uploaded as events, by account. The scraper
// asks for an account's list (GET /api/instagram/accounts/:username) and skips those posts.
// Creating an event with `instagramAccount` and `instagramPostUrl` adds the post to the list.
//
// Posts are keyed by their shortcode (the "C1abcDEF" in instagram.com/p/C1abcDEF/), which is
// the same whether a link says /p/, /reel/ or /tv/, so a post can't be uploaded twice.
// Deleting an event keeps its post on the list (event_id becomes null): it was still
// handled, and the scraper shouldn't bring back an event a moderator removed.

db.exec(`
  CREATE TABLE IF NOT EXISTS instagram_posts (
    shortcode  TEXT PRIMARY KEY,                          -- case-sensitive
    url        TEXT NOT NULL,                             -- canonical permalink
    username   TEXT NOT NULL,                             -- lowercase, without "@"
    event_id   TEXT REFERENCES events (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_posts_username ON instagram_posts (username, created_at);

  -- Replaced by instagram_posts: it only held each account's latest post timestamp.
  DROP TABLE IF EXISTS instagram_accounts;
`);

export interface InstagramPost {
  shortcode: string;
  /** Canonical permalink, e.g. https://www.instagram.com/p/C1abcDEF/ */
  url: string;
}

export interface UploadedInstagramPost extends InstagramPost {
  username: string;
  /** The event made from it; null if that event was deleted since. */
  eventId: string | null;
  createdAt: string;
}

interface PostRow {
  shortcode: string;
  url: string;
  username: string;
  event_id: string | null;
  created_at: string;
}

const stmt = {
  find: db.prepare("SELECT * FROM instagram_posts WHERE shortcode = ?"),
  // Covered by idx_instagram_posts_username, so it reads only this account's rows.
  urlsFor: db.prepare("SELECT url FROM instagram_posts WHERE username = ? ORDER BY created_at DESC, shortcode"),
  accounts: db.prepare(`
    SELECT username, COUNT(*) AS post_count, MAX(created_at) AS last_uploaded_at
    FROM instagram_posts GROUP BY username ORDER BY username`),
  insert: db.prepare(
    "INSERT INTO instagram_posts (shortcode, url, username, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
};

/** The upload record for a post, if it was uploaded already. */
export function findInstagramPost(shortcode: string): UploadedInstagramPost | null {
  const row = stmt.find.get(shortcode) as PostRow | undefined;
  return row
    ? { shortcode: row.shortcode, url: row.url, username: row.username, eventId: row.event_id, createdAt: row.created_at }
    : null;
}

/** URLs of the account's uploaded posts, newest upload first. */
export function listInstagramPostUrls(username: string): string[] {
  return (stmt.urlsFor.all(username) as { url: string }[]).map((r) => r.url);
}

export function listInstagramAccounts(): { username: string; postCount: number; lastUploadedAt: string }[] {
  return (stmt.accounts.all() as { username: string; post_count: number; last_uploaded_at: string }[]).map((r) => ({
    username: r.username,
    postCount: r.post_count,
    lastUploadedAt: r.last_uploaded_at,
  }));
}

/**
 * Adds a post to the account's list. Throws if the post is already on a list (the
 * shortcode is the primary key); call it inside the transaction that creates the event.
 */
export function recordInstagramPost(post: InstagramPost, username: string, eventId: string, now: string): void {
  stmt.insert.run(post.shortcode, post.url, username, eventId, now);
}

/** True for the error recordInstagramPost throws when the post was uploaded already. */
export function isDuplicatePostError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: instagram_posts\.shortcode/.test(err.message);
}

// ---------------------------------------------------------------------------
// Parsing what people send

/** Instagram paths that aren't profiles (instagram.com/p/…, /reel/…, …). */
const NOT_PROFILES = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer", "legal", "web",
]);

/**
 * The username in "mcgillmagicclub", "@McGillMagicClub" or "https://www.instagram.com/mcgillmagicclub/",
 * lowercased; null if it isn't a valid Instagram username. Usernames are 1–30 letters, numbers,
 * periods and underscores, and can't start or end with a period or have two in a row.
 * This checks the format only; it doesn't ask Instagram whether the account exists.
 */
export function parseInstagramUsername(input: string): string | null {
  let text = input.trim();
  const link = text.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagr(?:\.am|am\.com)\/([^/?#]+)/i);
  if (link) {
    const segment = decodeURIComponent(link[1]!);
    if (NOT_PROFILES.has(segment.toLowerCase())) return null;
    text = segment;
  }
  const username = text.replace(/^@/, "").toLowerCase();
  return /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/.test(username) ? username : null;
}

/**
 * A post's permalink, in any of the forms Instagram uses:
 *   https://www.instagram.com/p/C1abcDEF/        (the Graph API's `permalink`)
 *   https://www.instagram.com/reel/C1abcDEF/?igsh=…
 *   instagram.com/mcgillmagicclub/p/C1abcDEF
 * -> { shortcode, url } with the canonical URL (no query string, trailing slash),
 * or null if it isn't a post link.
 */
export function parseInstagramPostUrl(input: string): InstagramPost | null {
  const match = input
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:www\.|m\.)?instagr(?:\.am|am\.com)\/(?:[a-z0-9._]{1,30}\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?(?:[?#].*)?$/i,
    );
  if (!match) return null;
  const kind = match[1]!.toLowerCase() === "reels" ? "reel" : match[1]!.toLowerCase();
  const shortcode = match[2]!;
  return { shortcode, url: `https://www.instagram.com/${kind}/${shortcode}/` };
}
