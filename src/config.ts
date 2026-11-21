import path from "node:path";

/** Project root (this file lives in src/ or dist/), so paths don't depend on the cwd. */
const root = path.resolve(import.meta.dirname, "..");

function parseLatLon(value: string): { latitude: number; longitude: number } | null {
  const [latitude, longitude] = value.split(",").map(Number);
  return value.trim() !== "" && Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude: latitude!, longitude: longitude! }
    : null;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: path.resolve(root, process.env.DB_PATH ?? "data/app.db"),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR ?? "uploads"),
  /** Frontend pages and compiled scripts. */
  publicDir: path.join(root, "public"),
  leafletDir: path.join(root, "node_modules", "leaflet", "dist"),
  leafletRotateDir: path.join(root, "node_modules", "leaflet-rotate", "dist"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Photon server that turns addresses into coordinates. "off" disables geocoding. */
  geocoderUrl: process.env.GEOCODER_URL ?? "https://photon.komoot.io",
  /** Identifies the app to the geocoder. Adding contact info is recommended. */
  geocoderUserAgent: process.env.GEOCODER_USER_AGENT ?? "UnemployedWizard/0.1 (free food events app)",
  /** Only match places inside this box: "minLon,minLat,maxLon,maxLat". Default: Montreal. Empty = anywhere. */
  geocoderBbox: process.env.GEOCODER_BBOX ?? "-73.98,45.40,-73.47,45.71",
  /** When several places match, pick the one nearest this point ("lat,lon"). Default: McGill. Empty = none. */
  geocoderCenter: parseLatLon(process.env.GEOCODER_CENTER ?? "45.5048,-73.5772"),
  /** Overpass API server for walkway data (OpenStreetMap paths). "off" disables it. */
  overpassUrl: process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  /** Max additional pictures per event (thumbnail not counted). */
  maxPicturesPerEvent: 20,
  /** Max size of a single uploaded image. */
  maxUploadBytes: 10 * 1024 * 1024,
};
