import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { config } from "./config.ts";
import { HttpError } from "./errors.ts";
import { MCGILL_BUILDINGS } from "./mcgill-buildings.ts";
import { bboxSchema, fetchOsmApiElements, walkwaysEnabled, type Bbox } from "./walkways.ts";

// Everything the pixel-art map layer draws, from OpenStreetMap: building footprints, roads,
// paths and the kind of ground (grass, paving, dirt, water). Fetched from Overpass, or the
// main OpenStreetMap API when Overpass is busy, then trimmed down and cached on disk.
// Data © OpenStreetMap contributors (ODbL).

type LatLng = [number, number];

/** Bump when the shape of MapData changes, so old cache files are fetched again. */
const MAPDATA_VERSION = 2;

export interface MapData {
  version: number;
  buildings: {
    id: number;
    ring: LatLng[];
    /** building:levels, when tagged. */
    levels: number | null;
    /** Height in metres, when tagged. */
    height: number | null;
    /** The building=* value (yes, apartments, office, ...). */
    kind: string;
    name: string | null;
    /** On McGill's campus list, or named/operated as McGill. */
    mcgill: boolean;
  }[];
  roads: { kind: string; name: string | null; lanes: number | null; width: number | null; pts: LatLng[] }[];
  paths: { sidewalk: boolean; dirt: boolean; pts: LatLng[] }[];
  areas: { kind: "grass" | "paved" | "dirt" | "water"; ring: LatLng[] }[];
}

type Tags = Record<string, string>;
type OsmElement =
  | { type: "node"; id: number; lat: number; lon: number }
  | { type: "way"; id: number; nodes: number[]; tags?: Tags }
  | { type: "relation"; id: number; members: { type: string; ref: number; role: string }[]; tags?: Tags };

const CACHE_DAYS = 30;
const cacheDir = path.join(path.dirname(config.dbPath), "mapdata");
const pending = new Map<string, Promise<MapData>>();

const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|road)(_link)?$/;
const PATHS = /^(footway|path|cycleway|steps|pedestrian|track|bridleway)$/;
const DIRT_SURFACE = /^(dirt|ground|earth|mud|sand|gravel|fine_gravel|compacted|unpaved|grass|woodchips|pebblestone)$/;

const num = (value: string | undefined): number | null => {
  const n = value === undefined ? NaN : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

/** Underground, indoor or under-a-building things the map shouldn't draw. */
function hidden(tags: Tags): boolean {
  return (
    (num(tags.layer) ?? 0) < 0 ||
    /^(yes|building_passage|culvert)$/.test(tags.tunnel ?? "") ||
    /^(underground|indoor)$/.test(tags.location ?? "") ||
    /^(yes|room|corridor|area)$/.test(tags.indoor ?? "")
  );
}

function areaKind(tags: Tags): MapData["areas"][number]["kind"] | null {
  if (tags.natural === "water" || tags.waterway === "riverbank" || tags.amenity === "fountain") return "water";
  if (tags.leisure === "swimming_pool" && tags.indoor !== "yes") return "water";
  if (/^(construction|brownfield)$/.test(tags.landuse ?? "") || /^(sand|bare_rock|scree)$/.test(tags.natural ?? "")) return "dirt";
  if (tags.leisure === "track" || (tags.leisure === "pitch" && DIRT_SURFACE.test(tags.surface ?? ""))) return "dirt";
  if (
    /^(grass|flowerbed|recreation_ground|meadow|village_green|cemetery|forest)$/.test(tags.landuse ?? "") ||
    /^(park|garden|pitch|playground|dog_park|golf_course|nature_reserve|common)$/.test(tags.leisure ?? "") ||
    /^(wood|scrub|grassland|heath)$/.test(tags.natural ?? "")
  ) {
    return "grass";
  }
  if (tags.amenity === "parking" && !/^(underground|multi-storey|rooftop)$/.test(tags.parking ?? "")) return "paved";
  if (tags.amenity === "marketplace" || tags.place === "square" || tags["area:highway"]) return "paved";
  if (tags.area === "yes" && tags.highway) return "paved";
  return null;
}

/** Joins the outer member ways of a multipolygon into closed rings (lists of node ids). */
function assembleRings(ways: number[][]): number[][] {
  const rings: number[][] = [];
  const open = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  while (open.length > 0) {
    let ring = open.shift()!;
    let grew = true;
    while (ring[0] !== ring.at(-1) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i]!;
        const end = ring.at(-1);
        if (w[0] === end) ring = ring.concat(w.slice(1));
        else if (w.at(-1) === end) ring = ring.concat([...w].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring.at(-1)) rings.push(ring);
  }
  return rings;
}

function pointInRing(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i]!;
    const [aj, bj] = ring[j]!;
    if (bi > lng !== bj > lng && lat < ((aj - ai) * (lng - bi)) / (bj - bi) + ai) inside = !inside;
  }
  return inside;
}

function isMcGill(tags: Tags, ring: LatLng[]): boolean {
  if (/mcgill/i.test(`${tags.name ?? ""} ${tags.operator ?? ""} ${tags.owner ?? ""}`)) return true;
  return MCGILL_BUILDINGS.some((b) => pointInRing(b.latitude, b.longitude, ring));
}

export function buildMapData(elements: OsmElement[]): MapData {
  const nodes = new Map<number, LatLng>();
  const ways = new Map<number, Extract<OsmElement, { type: "way" }>>();
  for (const el of elements) {
    if (el.type === "node") nodes.set(el.id, [Math.round(el.lat * 1e6) / 1e6, Math.round(el.lon * 1e6) / 1e6]);
    else if (el.type === "way") ways.set(el.id, el);
  }
  const coords = (ids: number[]): LatLng[] | null => {
    const out: LatLng[] = [];
    for (const id of ids) {
      const p = nodes.get(id);
      if (!p) return null; // part of the way is outside what we downloaded
      out.push(p);
    }
    return out;
  };
  const closed = (ids: number[]) => ids.length >= 4 && ids[0] === ids.at(-1);

  const data: MapData = { version: MAPDATA_VERSION, buildings: [], roads: [], paths: [], areas: [] };
  const addBuilding = (id: number, tags: Tags, ring: LatLng[]) => {
    if (/^(no|roof|construction|ruins|bridge)$/.test(tags.building ?? "") || hidden(tags)) return;
    data.buildings.push({
      id,
      ring,
      levels: num(tags["building:levels"]),
      height: num(tags.height),
      kind: tags.building ?? "yes",
      name: tags.name ?? null,
      mcgill: isMcGill(tags, ring),
    });
  };

  for (const way of ways.values()) {
    const tags = way.tags;
    if (!tags) continue;
    if (tags.building) {
      const ring = closed(way.nodes) ? coords(way.nodes) : null;
      if (ring) addBuilding(way.id, tags, ring);
      continue;
    }
    const kind = closed(way.nodes) ? areaKind(tags) : null;
    if (kind && !hidden(tags)) {
      const ring = coords(way.nodes);
      if (ring) data.areas.push({ kind, ring });
      continue;
    }
    if (hidden(tags) || !tags.highway) continue;
    const pts = coords(way.nodes);
    if (!pts || pts.length < 2) continue;
    if (ROADS.test(tags.highway) && tags.area !== "yes") {
      data.roads.push({ kind: tags.highway, name: tags.name ?? null, lanes: num(tags.lanes), width: num(tags.width), pts });
    } else if (PATHS.test(tags.highway) && tags.footway !== "crossing" && tags.area !== "yes") {
      data.paths.push({
        sidewalk: tags.footway === "sidewalk",
        dirt: DIRT_SURFACE.test(tags.surface ?? "") || (!tags.surface && /^(track|bridleway)$/.test(tags.highway)),
        pts,
      });
    }
  }

  for (const el of elements) {
    if (el.type !== "relation" || el.tags?.type !== "multipolygon") continue;
    const tags = el.tags;
    const outer = el.members
      .filter((m) => m.type === "way" && m.role !== "inner")
      .map((m) => ways.get(m.ref)?.nodes)
      .filter((n): n is number[] => n !== undefined);
    for (const ids of assembleRings(outer)) {
      const ring = coords(ids);
      if (!ring) continue;
      if (tags.building) addBuilding(el.id, tags, ring);
      else {
        const kind = areaKind(tags);
        if (kind && !hidden(tags)) data.areas.push({ kind, ring });
      }
    }
  }
  return data;
}

async function fetchFromOverpass(b: Bbox): Promise<OsmElement[]> {
  const box = `(${b.south},${b.west},${b.north},${b.east})`;
  const query = `[out:json][timeout:60];
(
  way["building"]${box};
  relation["building"]["type"="multipolygon"]${box};
  way["highway"]${box};
  way["landuse"]${box};
  relation["landuse"]["type"="multipolygon"]${box};
  way["leisure"]${box};
  relation["leisure"]["type"="multipolygon"]${box};
  way["natural"]${box};
  relation["natural"]["type"="multipolygon"]${box};
  way["amenity"~"^(parking|fountain|marketplace)$"]${box};
  way["area:highway"]${box};
  way["place"="square"]${box};
  way["waterway"="riverbank"]${box};
);
(._;>;);
out body qt;`;
  const res = await fetch(config.overpassUrl, {
    method: "POST",
    headers: {
      "User-Agent": config.geocoderUserAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Overpass responded with HTTP ${res.status}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

/** Fallback when Overpass is busy: the main OpenStreetMap API's map call (everything in the box). */
function fetchFromOsmApi(b: Bbox): Promise<OsmElement[]> {
  return fetchOsmApiElements<OsmElement>(b);
}

async function fetchMapData(b: Bbox): Promise<MapData> {
  try {
    return buildMapData(await fetchFromOverpass(b));
  } catch (err) {
    console.warn(`Overpass failed for map data (${err instanceof Error ? err.message : err}); trying the OpenStreetMap API`);
    return buildMapData(await fetchFromOsmApi(b));
  }
}

async function getMapData(b: Bbox): Promise<MapData> {
  // Same ~100 m rounding as walkways, so the same area reuses one cache file.
  const r = (n: number) => n.toFixed(3);
  const key = `${r(b.south)}_${r(b.west)}_${r(b.north)}_${r(b.east)}`;
  const file = path.join(cacheDir, `${key}.json`);

  try {
    const stat = await fs.promises.stat(file);
    if (Date.now() - stat.mtimeMs < CACHE_DAYS * 86_400_000) {
      const cached = JSON.parse(await fs.promises.readFile(file, "utf8")) as MapData;
      if (cached.version === MAPDATA_VERSION) return cached;
    }
  } catch {
    // Not cached yet.
  }

  let request = pending.get(key);
  if (!request) {
    const rounded = { south: +r(b.south), west: +r(b.west), north: +r(b.north), east: +r(b.east) };
    request = fetchMapData(rounded).then(async (data) => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(data));
      return data;
    });
    pending.set(key, request);
    request.finally(() => pending.delete(key)).catch(() => undefined);
  }
  return request;
}

export const mapDataRouter = Router();

// GET /api/mapdata?south=&west=&north=&east=
mapDataRouter.get("/", async (req, res) => {
  if (!walkwaysEnabled()) throw new HttpError(503, "Map data is turned off (OVERPASS_URL=off)");
  const bbox = bboxSchema.parse(req.query);
  try {
    res.set("Cache-Control", "public, max-age=86400").json(await getMapData(bbox));
  } catch (err) {
    console.warn("Map data lookup failed:", err instanceof Error ? err.message : err);
    throw new HttpError(502, "Couldn't load map data from OpenStreetMap");
  }
});
