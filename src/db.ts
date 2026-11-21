import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    date        TEXT NOT NULL,           -- YYYY-MM-DD
    start_time  TEXT NOT NULL,           -- HH:MM (24h)
    end_time    TEXT,                    -- HH:MM (24h), optional
    address     TEXT NOT NULL,
    room_number TEXT,
    free_items  TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    description TEXT NOT NULL DEFAULT '',
    thumbnail   TEXT,                    -- filename inside the upload dir
    latitude    REAL,                    -- from the address, or sent by the client
    longitude   REAL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_date ON events (date, start_time);

  CREATE TABLE IF NOT EXISTS event_pictures (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_pictures_event ON event_pictures (event_id, position);
`);

// Databases created before coordinates existed get the new columns added.
const eventColumns = new Set(
  (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name),
);
for (const column of ["latitude", "longitude"]) {
  if (!eventColumns.has(column)) db.exec(`ALTER TABLE events ADD COLUMN ${column} REAL`);
}

/** Run `fn` inside a SQLite transaction (node:sqlite has no built-in helper). */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
