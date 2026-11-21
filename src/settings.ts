import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { db } from "./db.ts";
import { HttpError } from "./errors.ts";

// Site settings, kept in the database so they survive restarts.
//
// "publicEditing" decides whether visitors may add, edit and remove events. Admins always
// can. An admin is anyone whose request carries the admin key in an X-Admin-Key header
// (the pages send it after you open them once with ?admin=<key>). The key comes from the
// ADMIN_KEY environment variable, or is generated on first start and stored here.

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const putSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
);

function readSetting(key: string): string | undefined {
  return (getSetting.get(key) as { value: string } | undefined)?.value;
}

/** Whether visitors (not just admins) may add, edit and remove events. On by default. */
export function publicEditingEnabled(): boolean {
  return readSetting("publicEditing") !== "0";
}

export function setPublicEditing(enabled: boolean): void {
  putSetting.run("publicEditing", enabled ? "1" : "0");
}

/** Where the admin key came from. Only a key from the database is printed at startup. */
export const adminKeySource: "env" | "database" = process.env.ADMIN_KEY?.trim() ? "env" : "database";

export const adminKey: string = (() => {
  if (adminKeySource === "env") return process.env.ADMIN_KEY!.trim();
  const stored = readSetting("adminKey");
  if (stored) return stored;
  const key = randomBytes(18).toString("base64url");
  putSetting.run("adminKey", key);
  return key;
})();

const digest = (s: string) => createHash("sha256").update(s).digest();
const adminKeyDigest = digest(adminKey);

/** Whether the request carries the admin key. Compared in constant time. */
export function isAdmin(req: Request): boolean {
  const given = req.get("x-admin-key");
  return Boolean(given) && timingSafeEqual(digest(given!), adminKeyDigest);
}

/** Lets a request through if visitors may edit events, or if it comes from an admin. */
export const requireEditAccess: RequestHandler = (req, _res, next) => {
  if (publicEditingEnabled() || isAdmin(req)) next();
  else next(new HttpError(403, "Adding, editing and removing events is turned off right now."));
};

/** Lets only admins through. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (isAdmin(req)) next();
  else next(new HttpError(403, "Admin key required"));
};
