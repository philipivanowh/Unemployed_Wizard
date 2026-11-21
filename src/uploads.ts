import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import multer from "multer";
import { config } from "./config.ts";
import { HttpError } from "./errors.ts";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

fs.mkdirSync(config.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: config.uploadDir,
  // Never trust the client's filename; generate our own.
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${MIME_TO_EXT[file.mimetype] ?? ""}`),
});

/**
 * Accepts multipart/form-data with:
 *   - `thumbnail`: a single image
 *   - `pictures`:  up to `maxPicturesPerEvent` images
 * Text fields end up in `req.body`.
 */
export const eventImagesUpload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxPicturesPerEvent + 1,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype in MIME_TO_EXT) cb(null, true);
    else cb(new HttpError(400, `Unsupported image type "${file.mimetype}". Use JPEG, PNG, WebP or GIF.`));
  },
}).fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "pictures", maxCount: config.maxPicturesPerEvent },
]);

export interface UploadedEventImages {
  thumbnail?: string;
  pictures: string[];
  /** Every filename saved for this request, for cleanup on failure. */
  all: string[];
}

export function getUploadedImages(req: Request): UploadedEventImages {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const thumbnail = files?.thumbnail?.[0]?.filename;
  const pictures = (files?.pictures ?? []).map((f) => f.filename);
  return { thumbnail, pictures, all: thumbnail ? [thumbnail, ...pictures] : pictures };
}

export function uploadUrl(filename: string): string {
  return `/uploads/${encodeURIComponent(filename)}`;
}

/** Best-effort removal of stored images; never throws. */
export async function deleteUploads(filenames: Iterable<string>): Promise<void> {
  await Promise.all(
    [...filenames].map(async (name) => {
      try {
        await fs.promises.unlink(path.join(config.uploadDir, path.basename(name)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Failed to delete upload ${name}:`, err);
        }
      }
    }),
  );
}
