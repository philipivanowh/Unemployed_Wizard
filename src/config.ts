import path from "node:path";

/** Project root (this file lives in src/ or dist/), so paths don't depend on the cwd. */
const root = path.resolve(import.meta.dirname, "..");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: path.resolve(root, process.env.DB_PATH ?? "data/app.db"),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR ?? "uploads"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Max additional pictures per event (thumbnail not counted). */
  maxPicturesPerEvent: 20,
  /** Max size of a single uploaded image. */
  maxUploadBytes: 10 * 1024 * 1024,
};
