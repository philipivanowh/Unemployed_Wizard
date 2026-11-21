import { z } from "zod";

// multipart/form-data sends everything as strings, so these helpers coerce
// form values into the shapes we validate. JSON bodies pass through as-is.

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** Accepts an array, a JSON array string ('["Pizza","Soda"]'), or a comma-separated string ("Pizza, Soda"). */
function toStringList(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      return v; // let validation report it
    }
  }
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toBoolean(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off", ""].includes(s)) return false;
  return v;
}

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD")
  .refine(isRealDate, "Not a real calendar date");

const timeField = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour time as HH:MM");

/** Optional number within [min, max]; an empty form value means null (no location). */
const coordinate = (min: number, max: number) =>
  z.preprocess(emptyToNull, z.coerce.number().min(min).max(max).nullable());

const requiredText = (max: number) => z.string().trim().min(1, "Required").max(max);

const eventFields = {
  title: requiredText(120),
  date: dateField,
  startTime: timeField,
  endTime: z.preprocess(emptyToNull, timeField.nullable()),
  address: requiredText(300),
  roomNumber: z.preprocess(emptyToNull, z.string().trim().max(50).nullable()),
  freeItems: z.preprocess(
    toStringList,
    z
      .array(z.string().trim().min(1).max(100))
      .min(1, "List at least one free item")
      .max(50),
  ),
  description: z.string().trim().max(5000),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
};

export const createEventSchema = z.object({
  ...eventFields,
  endTime: eventFields.endTime.optional(),
  roomNumber: eventFields.roomNumber.optional(),
  description: eventFields.description.optional(),
  latitude: eventFields.latitude.optional(),
  longitude: eventFields.longitude.optional(),
});

export const updateEventSchema = z
  .object(eventFields)
  .partial()
  .extend({
    /** IDs of existing pictures to delete. */
    removePictureIds: z.preprocess(toStringList, z.array(z.string().min(1)).max(100)).optional(),
    /** Clear the thumbnail without uploading a new one. */
    removeThumbnail: z.preprocess(toBoolean, z.boolean()).optional(),
  });

export const listEventsQuerySchema = z.object({
  from: dateField.optional(),
  to: dateField.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
