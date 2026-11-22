import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { config } from "./config.ts";
import { HttpError } from "./errors.ts";

// Walkable paths and streets from OpenStreetMap (via the Overpass API), as a graph the
// map's NPCs walk along. Results are cached on disk, so each area is fetched once.
// Data © OpenStreetMap contributors (ODbL).

export interface WalkwayGraph {
  /** [lat, lng] for each node. */
  nodes: [number, number][];
  /** Pairs of indexes into `nodes`. */
  edges: [number, number][];
}

/** Ways people can walk on. Motorways and trunk roads are left out. */
const WALKABLE =
  "footway|pedestrian|path|steps|living_street|residential|tertiary|secondary|primary|unclassified|service|cycleway";
const MAX_SPAN_DEGREES = 0.08; // about 8 km; bigger boxes are refused (the OSM API caps a box at 50,000 nodes)
const CACHE_DAYS = 30;

export const bboxSchema = z
  .object({
    south: z.coerce.number().min(-90).max(90),
    west: z.coerce.number().min(-180).max(180),
    north: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
  })
  .refine((b) => b.north > b.south && b.east > b.west, "north/east must be greater than south/west")
  .refine(
    (b) => b.north - b.south <= MAX_SPAN_DEGREES && b.east - b.west <= MAX_SPAN_DEGREES,
    `The box can be at most ${MAX_SPAN_DEGREES}° on each side`,
  );

export type Bbox = z.infer<typeof bboxSchema>;

const cacheDir = path.join(path.dirname(config.dbPath), "walkways");
/** Requests in flight, so simultaneous page loads share one Overpass call. */
const pending = new Map<string, Promise<WalkwayGraph>>();

export function walkwaysEnabled(): boolean {
  return config.overpassUrl !== "" && config.overpassUrl !== "off";
}

type OsmElement =
  | { type: "node"; id: number; lat: number; lon: number }
  | { type: "way"; id: number; nodes: number[]; tags?: Record<string, string> }
  | { type: "relation"; id: number };

const walkablePattern = new RegExp(`^(${WALKABLE})$`);

/** Keeps outdoor ways people may walk on. Ways without tags were already filtered by Overpass. */
function isWalkable(tags: Record<string, string> | undefined): boolean {
  if (!tags) return true;
  return (
    walkablePattern.test(tags.highway ?? "") &&
    !/^(private|no)$/.test(tags.access ?? "") &&
    tags.foot !== "no" &&
    !/^(yes|room|corridor|area)$/.test(tags.indoor ?? "")
  );
}

function buildGraph(elements: OsmElement[]): WalkwayGraph {
  const ways = elements.filter(
    (el): el is Extract<OsmElement, { type: "way" }> => el.type === "way" && isWalkable(el.tags),
  );
  const used = new Set(ways.flatMap((w) => w.nodes));
  const index = new Map<number, number>();
  const nodes: [number, number][] = [];
  for (const el of elements) {
    if (el.type === "node" && used.has(el.id) && !index.has(el.id)) {
      index.set(el.id, nodes.length);
      nodes.push([Math.round(el.lat * 1e6) / 1e6, Math.round(el.lon * 1e6) / 1e6]);
    }
  }
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const way of ways) {
    for (let i = 1; i < way.nodes.length; i++) {
      const a = index.get(way.nodes[i - 1]!);
      const b = index.get(way.nodes[i]!);
      if (a === undefined || b === undefined || a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }
  return { nodes, edges };
}

async function fetchFromOverpass(b: Bbox): Promise<WalkwayGraph> {
  const query = `[out:json][timeout:25];
way["highway"~"^(${WALKABLE})$"]["access"!~"^(private|no)$"]["foot"!="no"]["indoor"!~"^(yes|room|corridor|area)$"](${b.south},${b.west},${b.north},${b.east});
(._;>;);
out skel qt;`;
  const res = await fetch(config.overpassUrl, {
    method: "POST",
    headers: {
      "User-Agent": config.geocoderUserAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Overpass responded with HTTP ${res.status}`);
  return buildGraph(((await res.json()) as { elements: OsmElement[] }).elements);
}

/**
 * Fallback when Overpass is busy (it often is): the main OpenStreetMap API's map call.
 * It's meant for occasional reads, which is fine here because results are cached. It refuses
 * boxes with more than 50,000 nodes, so the box is fetched in pieces of about 1 km and merged.
 */
export async function fetchOsmApiElements<T extends { type: string; id: number }>(b: Bbox): Promise<T[]> {
  const STEP = 0.01;
  const merged = new Map<string, T>();
  for (let south = b.south; south < b.north; south += STEP) {
    for (let west = b.west; west < b.east; west += STEP) {
      const north = Math.min(b.north, south + STEP);
      const east = Math.min(b.east, west + STEP);
      const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${west},${south},${east},${north}`;
      const res = await fetch(url, {
        headers: { "User-Agent": config.geocoderUserAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`OpenStreetMap API responded with HTTP ${res.status}`);
      for (const el of ((await res.json()) as { elements: T[] }).elements) merged.set(`${el.type}/${el.id}`, el);
    }
  }
  return [...merged.values()];
}

async function fetchFromOsmApi(b: Bbox): Promise<WalkwayGraph> {
  return buildGraph(await fetchOsmApiElements<OsmElement>(b));
}

async function fetchWalkways(b: Bbox): Promise<WalkwayGraph> {
  try {
    return await fetchFromOverpass(b);
  } catch (err) {
    console.warn(`Overpass failed (${err instanceof Error ? err.message : err}); trying the OpenStreetMap API`);
    return fetchFromOsmApi(b);
  }
}

async function getWalkways(b: Bbox): Promise<WalkwayGraph> {
  // Round to ~100 m so tiny changes to the area reuse the same cache file.
  const r = (n: number) => n.toFixed(3);
  const key = `${r(b.south)}_${r(b.west)}_${r(b.north)}_${r(b.east)}`;
  const file = path.join(cacheDir, `${key}.json`);

  try {
    const stat = await fs.promises.stat(file);
    if (Date.now() - stat.mtimeMs < CACHE_DAYS * 86_400_000) {
      return JSON.parse(await fs.promises.readFile(file, "utf8")) as WalkwayGraph;
    }
  } catch {
    // Not cached yet.
  }

  let request = pending.get(key);
  if (!request) {
    const rounded = { south: +r(b.south), west: +r(b.west), north: +r(b.north), east: +r(b.east) };
    request = fetchWalkways(rounded).then(async (graph) => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(graph));
      return graph;
    });
    pending.set(key, request);
    request.finally(() => pending.delete(key)).catch(() => undefined);
  }
  return request;
}

export const walkwaysRouter = Router();

// GET /api/walkways?south=&west=&north=&east=
walkwaysRouter.get("/", async (req, res) => {
  if (!walkwaysEnabled()) throw new HttpError(503, "Walkways are turned off (OVERPASS_URL=off)");
  const bbox = bboxSchema.parse(req.query);
  try {
    res.set("Cache-Control", "public, max-age=86400").json(await getWalkways(bbox));
  } catch (err) {
    console.warn("Walkway lookup failed:", err instanceof Error ? err.message : err);
    throw new HttpError(502, "Couldn't load walkways from OpenStreetMap");
  }
});
