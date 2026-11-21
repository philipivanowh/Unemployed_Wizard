import { config } from "./config.ts";

// Address -> coordinates using Photon (https://photon.komoot.io), a free geocoder built on
// OpenStreetMap data. It copes with loosely typed addresses and building names better than
// Nominatim.
//
// Every search stays inside Montreal (config.geocoderBbox) and, when several places match
// equally well, the one nearest McGill (config.geocoderCenter) wins.
//
// OpenStreetMap stores Montreal streets under their French names ("Rue Sherbrooke Ouest"),
// so English-style addresses ("845 Sherbrooke St W") are also searched in French form.

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** What was matched, e.g. "Université McGill, 845 Rue Sherbrooke Ouest, Montréal". */
  label?: string;
}

interface Candidate {
  label: string;
  latitude: number;
  longitude: number;
  houseNumber: string | null;
}

const MIN_INTERVAL_MS = 1000; // be gentle with the free public server
const CACHE_LIMIT = 1000;
const RESULTS_PER_QUERY = 10;

/** Query -> candidates from Photon. */
const cache = new Map<string, Candidate[]>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export function geocodingEnabled(): boolean {
  return config.geocoderUrl !== "" && config.geocoderUrl !== "off";
}

/**
 * Best location for an address in Montreal, nearest McGill when several match. Returns
 * null if geocoding is off, nothing matched, or the lookup failed (failures are logged
 * and not cached, so they can be retried).
 *
 * If the address starts with a house number, only a building with that number on that
 * street counts: a pin somewhere along a long street (or on a look-alike street across
 * town) would be worse than no pin.
 */
export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  const query = address.trim();
  if (!geocodingEnabled() || !query) return null;
  try {
    const queries = [query];
    const french = frenchStreetVariant(query);
    if (french) queries.push(french);

    const candidates: Candidate[] = [];
    for (const q of queries) candidates.push(...(await photonSearch(q)));

    const best = pickBest(query, candidates);
    return best ? { latitude: best.latitude, longitude: best.longitude, label: best.label } : null;
  } catch (err) {
    console.warn(`Geocoding failed for "${address}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ranking

function pickBest(address: string, candidates: Candidate[]): Candidate | null {
  const number = address.match(/^\s*(\d+[a-z]?)\b/i)?.[1]?.toLowerCase();
  const words = streetWords(address);

  const scored = candidates.map((c) => {
    const labelWords = new Set(normalizeText(c.label).split(/[^a-z0-9]+/));
    return {
      c,
      sameNumber: number !== undefined && c.houseNumber?.toLowerCase() === number,
      sameStreet: words.some((w) => labelWords.has(w)),
      distance: distanceFromCenter(c),
    };
  });

  // "845 Sherbrooke St W": the building must have that number and be on that street.
  const usable =
    number === undefined ? scored : scored.filter((s) => s.sameNumber && (words.length === 0 || s.sameStreet));
  usable.sort(
    (a, b) =>
      Number(b.sameNumber) - Number(a.sameNumber) ||
      Number(b.sameStreet) - Number(a.sameStreet) ||
      a.distance - b.distance,
  );
  return usable[0]?.c ?? null;
}

/** Approximate distance in km from config.geocoderCenter (McGill); 0 if no center is set. */
function distanceFromCenter(c: Candidate): number {
  const center = config.geocoderCenter;
  if (!center) return 0;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = kmPerDegLat * Math.cos((center.latitude * Math.PI) / 180);
  return Math.hypot((c.latitude - center.latitude) * kmPerDegLat, (c.longitude - center.longitude) * kmPerDegLon);
}

function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// English -> French street address

const STREET_TYPES: Record<string, string> = {
  street: "rue",
  st: "rue",
  avenue: "avenue",
  ave: "avenue",
  av: "avenue",
  boulevard: "boulevard",
  blvd: "boulevard",
  boul: "boulevard",
  road: "chemin",
  rd: "chemin",
  place: "place",
  pl: "place",
  square: "square",
  sq: "square",
};

const DIRECTIONS: Record<string, string> = {
  w: "Ouest",
  west: "Ouest",
  e: "Est",
  east: "Est",
  n: "Nord",
  north: "Nord",
  s: "Sud",
  south: "Sud",
};

const FRENCH_START = /^(rue|avenue|av|boulevard|boul|chemin|ch|place|côte|cote|square|carré|allée|ruelle)\b/i;

/** "845 Sherbrooke St W, Montreal" -> "845 rue Sherbrooke Ouest, Montreal". Null if it doesn't apply. */
export function frenchStreetVariant(address: string): string | null {
  const [first = "", ...rest] = address.split(",");
  const match = first.trim().match(/^(\d+[a-z]?)\s+(.+?)\s+(\p{L}+)\.?(?:\s+(\p{L}+)\.?)?$/iu);
  if (!match) return null;
  const [, number, name = "", word1 = "", word2] = match;
  if (FRENCH_START.test(name)) return null; // already "rue …"

  let streetType = STREET_TYPES[word1.toLowerCase()];
  let direction = word2 ? DIRECTIONS[word2.toLowerCase()] : undefined;
  if (word2 && !direction) return null;
  if (!streetType) {
    // "845 Sherbrooke West": no street type, the last word is the direction.
    if (word2 || !DIRECTIONS[word1.toLowerCase()]) return null;
    direction = DIRECTIONS[word1.toLowerCase()];
    streetType = "rue";
  }
  const street = `${number} ${streetType} ${name}${direction ? ` ${direction}` : ""}`;
  return [street, ...rest].join(",");
}

const GENERIC_WORDS = new Set([
  ...Object.keys(STREET_TYPES),
  ...Object.keys(DIRECTIONS),
  ...["rue", "ouest", "est", "nord", "sud", "chemin", "cote", "des", "les", "montreal", "quebec", "canada"],
]);

/** Distinctive words of the street part of an address: "1455 De Maisonneuve Blvd W" -> ["maisonneuve"]. */
function streetWords(address: string): string[] {
  return normalizeText(address.split(",")[0] ?? "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d/.test(w) && !GENERIC_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Photon

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
  };
}

function toCandidate(feature: PhotonFeature): Candidate | null {
  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const p = feature.properties ?? {};
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const parts = [p.name, street, p.city ?? p.district].filter((x): x is string => Boolean(x));
  return {
    label: [...new Set(parts)].join(", ") || "Unnamed place",
    latitude: latitude!,
    longitude: longitude!,
    houseNumber: p.housenumber ?? null,
  };
}

async function photonSearch(query: string): Promise<Candidate[]> {
  const key = query.toLowerCase().replace(/\s+/g, " ");
  const cached = cache.get(key);
  if (cached) return cached;

  // Requests run one at a time so they stay under the rate limit.
  const request = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const params = new URLSearchParams({ q: query, limit: String(RESULTS_PER_QUERY) });
    if (config.geocoderBbox) params.set("bbox", config.geocoderBbox);
    if (config.geocoderCenter) {
      params.set("lat", String(config.geocoderCenter.latitude));
      params.set("lon", String(config.geocoderCenter.longitude));
    }
    const res = await fetch(`${config.geocoderUrl.replace(/\/+$/, "")}/api/?${params}`, {
      headers: { "User-Agent": config.geocoderUserAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Geocoder responded with HTTP ${res.status}`);
    const body = (await res.json()) as { features?: PhotonFeature[] };
    return (body.features ?? []).flatMap((f) => toCandidate(f) ?? []);
  });
  queue = request.catch(() => undefined);

  const results = await request;
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, results);
  return results;
}
