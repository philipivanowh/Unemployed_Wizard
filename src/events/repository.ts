import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { db, transaction } from "../db.ts";

export interface EventFields {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string | null; // HH:MM
  address: string;
  roomNumber: string | null;
  freeItems: string[];
  description: string;
}

export interface Picture {
  id: string;
  filename: string;
}

export interface EventRecord extends EventFields {
  id: string;
  thumbnail: string | null;
  pictures: Picture[];
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string | null;
  address: string;
  room_number: string | null;
  free_items: string;
  description: string;
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

interface PictureRow {
  id: string;
  event_id: string;
  filename: string;
  position: number;
}

const stmt = {
  getEvent: db.prepare("SELECT * FROM events WHERE id = ?"),
  insertEvent: db.prepare(`
    INSERT INTO events (id, title, date, start_time, end_time, address, room_number,
                        free_items, description, thumbnail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateEvent: db.prepare(`
    UPDATE events SET title = ?, date = ?, start_time = ?, end_time = ?, address = ?,
                      room_number = ?, free_items = ?, description = ?, thumbnail = ?, updated_at = ?
    WHERE id = ?`),
  deleteEvent: db.prepare("DELETE FROM events WHERE id = ?"),
  picturesForEvent: db.prepare(
    "SELECT * FROM event_pictures WHERE event_id = ? ORDER BY position, created_at",
  ),
  maxPicturePosition: db.prepare(
    "SELECT COALESCE(MAX(position), -1) AS max FROM event_pictures WHERE event_id = ?",
  ),
  insertPicture: db.prepare(
    "INSERT INTO event_pictures (id, event_id, filename, position, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  deletePicture: db.prepare("DELETE FROM event_pictures WHERE id = ? AND event_id = ?"),
};

function toRecord(row: EventRow, pictures: PictureRow[]): EventRecord {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    address: row.address,
    roomNumber: row.room_number,
    freeItems: JSON.parse(row.free_items) as string[],
    description: row.description,
    thumbnail: row.thumbnail,
    pictures: pictures.map((p) => ({ id: p.id, filename: p.filename })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertPictures(eventId: string, filenames: string[], now: string): void {
  const { max } = stmt.maxPicturePosition.get(eventId) as { max: number };
  filenames.forEach((filename, i) => {
    stmt.insertPicture.run(randomUUID(), eventId, filename, max + 1 + i, now);
  });
}

export function getEvent(id: string): EventRecord | null {
  const row = stmt.getEvent.get(id) as EventRow | undefined;
  if (!row) return null;
  return toRecord(row, stmt.picturesForEvent.all(id) as unknown as PictureRow[]);
}

export interface ListEventsOptions {
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export function listEvents(opts: ListEventsOptions): { events: EventRecord[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (opts.from) {
    where.push("date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("date <= ?");
    params.push(opts.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM events ${whereSql}`).get(...params) as {
    total: number;
  };
  const rows = db
    .prepare(`SELECT * FROM events ${whereSql} ORDER BY date, start_time, created_at LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as unknown as EventRow[];

  if (rows.length === 0) return { events: [], total };

  const ids = rows.map((r) => r.id);
  const pictureRows = db
    .prepare(
      `SELECT * FROM event_pictures WHERE event_id IN (${ids.map(() => "?").join(",")})
       ORDER BY position, created_at`,
    )
    .all(...ids) as unknown as PictureRow[];

  const byEvent = new Map<string, PictureRow[]>();
  for (const p of pictureRows) {
    const list = byEvent.get(p.event_id) ?? [];
    list.push(p);
    byEvent.set(p.event_id, list);
  }

  return { events: rows.map((r) => toRecord(r, byEvent.get(r.id) ?? [])), total };
}

export function createEvent(
  fields: EventFields,
  images: { thumbnail: string | null; pictures: string[] },
): EventRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  transaction(() => {
    stmt.insertEvent.run(
      id,
      fields.title,
      fields.date,
      fields.startTime,
      fields.endTime,
      fields.address,
      fields.roomNumber,
      JSON.stringify(fields.freeItems),
      fields.description,
      images.thumbnail,
      now,
      now,
    );
    insertPictures(id, images.pictures, now);
  });
  return getEvent(id)!;
}

export interface UpdateEventOptions {
  /** `undefined` keeps the current thumbnail, `null` clears it, a string replaces it. */
  thumbnail?: string | null;
  addPictures?: string[];
  removePictureIds?: string[];
}

/**
 * Applies a partial update. Returns the updated event plus the filenames that are no
 * longer referenced (so the caller can delete them after the commit), or null if the
 * event does not exist.
 */
export function updateEvent(
  id: string,
  patch: Partial<EventFields>,
  opts: UpdateEventOptions = {},
): { event: EventRecord; orphanedFiles: string[] } | null {
  const existing = getEvent(id);
  if (!existing) return null;

  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<EventFields>;
  const merged: EventFields = { ...existing, ...definedPatch };
  const orphanedFiles: string[] = [];
  const now = new Date().toISOString();

  let thumbnail = existing.thumbnail;
  if (opts.thumbnail !== undefined) {
    if (existing.thumbnail && existing.thumbnail !== opts.thumbnail) orphanedFiles.push(existing.thumbnail);
    thumbnail = opts.thumbnail;
  }

  transaction(() => {
    stmt.updateEvent.run(
      merged.title,
      merged.date,
      merged.startTime,
      merged.endTime,
      merged.address,
      merged.roomNumber,
      JSON.stringify(merged.freeItems),
      merged.description,
      thumbnail,
      now,
      id,
    );

    for (const pictureId of new Set(opts.removePictureIds ?? [])) {
      const picture = existing.pictures.find((p) => p.id === pictureId);
      if (picture) {
        stmt.deletePicture.run(pictureId, id);
        orphanedFiles.push(picture.filename);
      }
    }

    insertPictures(id, opts.addPictures ?? [], now);
  });

  return { event: getEvent(id)!, orphanedFiles };
}

/** Deletes the event and returns the filenames it referenced, or null if not found. */
export function deleteEvent(id: string): string[] | null {
  const existing = getEvent(id);
  if (!existing) return null;
  stmt.deleteEvent.run(id); // pictures cascade
  return [...(existing.thumbnail ? [existing.thumbnail] : []), ...existing.pictures.map((p) => p.filename)];
}
