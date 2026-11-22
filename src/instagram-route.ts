import { Router } from "express";
import { HttpError } from "./errors.ts";
import { listInstagramAccounts, listInstagramPostUrls, parseInstagramUsername } from "./instagram.ts";

// GET /api/instagram/accounts/:username
//   -> { username, postUrls: [...] }: links to the account's posts that have already been
//   parsed and uploaded as events, newest upload first. It grows as events are created, so
//   the scraper can skip these posts. Empty for an account nothing has come from yet.
//   :username may be "name", "@name" or a URL-encoded profile link.
// GET /api/instagram/accounts
//   -> { accounts: [{ username, postCount, lastUploadedAt }] }, every account posts came from.

export const instagramRouter = Router();

instagramRouter.get("/accounts", (_req, res) => {
  res.json({ accounts: listInstagramAccounts() });
});

instagramRouter.get("/accounts/:username", (req, res) => {
  const username = parseInstagramUsername(String(req.params.username));
  if (!username) {
    throw new HttpError(400, "Not a valid Instagram account", [
      { path: "username", message: "Use the username (mcgillmagicclub), @username or a profile link." },
    ]);
  }
  res.json({ username, postUrls: listInstagramPostUrls(username) });
});
