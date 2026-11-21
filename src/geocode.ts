import { config } from "./config.ts";

// Address -> coordinates using OpenStreetMap's Nominatim.
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
// at most 1 request per second, an identifying User-Agent, and cache results.

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** What Nominatim matched, e.g. "Rue Sherbrooke Ouest, Ville-Marie, Montréal, …". */
  label?: string;
}

/** Area to prefer results in: [west, south, east, north]. Results elsewhere are still allowed. */
export type Viewbox = [number, number, number, number];

const MIN_INTERVAL_MS = 1100;
const CACHE_LIMIT = 1000;

/** Normalized address -> result. `null` means Nominatim found nothing. */
const cache = new Map<string, Coordinates | null>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export function geocodingEnabled(): boolean {
  return config.geocoderUrl !== "" && config.geocoderUrl !== "off";
}

/**
 * Looks up an address. Returns null if geocoding is off, nothing matched, or the
 * lookup failed (failures are logged and not cached, so they can be retried).
 */
export async function geocodeAddress(address: string, viewbox?: Viewbox): Promise<Coordinates | null> {
  if (!geocodingEnabled()) return null;
  const normalized = address.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return null;
  const key = viewbox ? `${normalized}|${viewbox.map((n) => n.toFixed(3)).join(",")}` : normalized;
  if (cache.has(key)) return cache.get(key) ?? null;

  // Requests run one at a time so they stay under the rate limit.
  const request = queue.then(() => lookup(address.trim(), viewbox));
  queue = request.catch(() => undefined);

  try {
    const result = await request;
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`Geocoding failed for "${address}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function lookup(address: string, viewbox?: Viewbox): Promise<Coordinates | null> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const params = new URLSearchParams({ q: address, format: "jsonv2", limit: "1" });
  if (viewbox) {
    params.set("viewbox", viewbox.join(","));
    params.set("bounded", "0"); // prefer the box, but still find places outside it
  }
  const res = await fetch(`${config.geocoderUrl.replace(/\/+$/, "")}/search?${params}`, {
    headers: { "User-Agent": config.geocoderUserAgent, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Geocoder responded with HTTP ${res.status}`);

  const results = (await res.json()) as { lat?: string; lon?: string; display_name?: string }[];
  const first = results[0];
  if (!first) return null;
  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude, label: first.display_name };
}
