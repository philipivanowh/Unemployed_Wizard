// Makes the backend "forget" Instagram posts, so the scraper will parse and upload them again.
//
// Deleting an event deliberately keeps its post on the already-uploaded list (so the scraper
// doesn't bring back events a moderator removed). While testing you often want the opposite.
//
//   node forget-instagram-post.mjs             forget every post whose event was deleted
//   node forget-instagram-post.mjs C1abcDEFg   forget one post, by its shortcode
//                                              (the C1abcDEFg in instagram.ts/p/C1abcDEFg/)
//   node forget-instagram-post.mjs --account wherethefoodat.tracker   forget all of an account's posts
//
// Run it from the repo root. It edits the database file directly, so it needs no admin key
// (it works whether or not the backend is running). Posts whose events still exist are only
// touched if you name them, because forgetting those would create duplicate events.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.DB_PATH ?? "data/app.db";
const db = new DatabaseSync(dbPath);
const [first, second] = process.argv.slice(2);

let result;
if (first === "--account" && second) {
  result = db.prepare("DELETE FROM instagram_posts WHERE username = ?").run(second.replace(/^@/, "").toLowerCase());
} else if (first && !first.startsWith("--")) {
  result = db.prepare("DELETE FROM instagram_posts WHERE shortcode = ?").run(first);
} else if (!first) {
  result = db.prepare("DELETE FROM instagram_posts WHERE event_id IS NULL").run();
} else {
  console.error("Usage: node forget-instagram-post.mjs [shortcode | --account username]");
  process.exit(1);
}
console.log(`Forgot ${result.changes} post(s) in ${dbPath}.`);
