import path from "node:path";

/** Project root (this file lives in src/ or dist/), so paths don't depend on the cwd. */
const root = path.resolve(import.meta.dirname, "..");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: path.resolve(root, process.env.DB_PATH ?? "data/app.db"),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR ?? "uploads"),
  /** Frontend pages and compiled scripts. */
  publicDir: path.join(root, "public"),
  leafletDir: path.join(root, "node_modules", "leaflet", "dist"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Nominatim server that turns addresses into coordinates. "off" disables geocoding. */
  geocoderUrl: process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org",
  /** Nominatim requires a User-Agent that identifies the app. Adding contact info is recommended. */
  geocoderUserAgent: process.env.GEOCODER_USER_AGENT ?? "UnemployedWizard/0.1 (free food events app)",
  /** Max additional pictures per event (thumbnail not counted). */
  maxPicturesPerEvent: 20,
  /** Max size of a single uploaded image. */
  maxUploadBytes: 10 * 1024 * 1024,
};
