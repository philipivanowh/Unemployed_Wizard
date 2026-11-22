// Pixel-art map layer: the area outline (area-data.ts) drawn as 16 px terrain tiles with
// buildings on top, from OpenStreetMap data (/api/mapdata).
//
// - Scale: one art pixel is one map pixel at zoom 19 (about 0.21 m), so a 16 px tile is about
//   3.35 m. At other zooms the art is scaled; it's hidden below PIXEL_MIN_ZOOM.
// - Rotation: leaflet-rotate turns the map with CSS, which would tilt and blur pixel art. So the
//   layer is one canvas the size of the map, placed in the rotated pane and turned back by the
//   same angle: its pixels line up with the screen, and it still sits under route lines and
//   above the OpenStreetMap tiles. Art is laid out on a grid that is the map's projection
//   rotated by the bearing, so streets (which run at the bearing) come out square.
// - Terrain: every tile corner gets a terrain (grass, dirt, sidewalk, water, road) and each tile
//   picks the matching corner tile from one of the four Wang sheets in /tiles.
// - Buildings: downtown buildings use the four stretchable types in buildings-downtown.json
//   (see its how_to_stretch). McGill buildings get the copper roof with a stone front wall
//   (walls.png) until they have their own art. Rows of small houses are merged into fewer,
//   bigger ones. All buildings sit on whole tiles.
// - Props (trees, bushes, lamps, benches) are scattered from the ground; fences and other hand
//   edits come from public/map-edits.json.
// - Speed: the world is drawn in 512 px chunks, at up to five sizes (mipmaps), cached and drawn
//   a few per frame.
// Loaded as a plain script; map.ts creates the layer.

const PIXEL_ZOOM = 19;
const PIXEL_TILE = 16;
const PIXEL_CHUNK_TILES = 32;
const PIXEL_CHUNK = PIXEL_TILE * PIXEL_CHUNK_TILES;
const PIXEL_MAX_LEVEL = 4;
/** Below this zoom the OpenStreetMap map shows instead (the art would be under 1 px per tile). */
const PIXEL_MIN_ZOOM = 15;
const PIXEL_CACHE_BYTES = 160 * 1024 * 1024;
/** Milliseconds of chunk drawing per frame before the rest waits for the next frame. */
const PIXEL_FRAME_BUDGET = 9;

const TERRAIN_GRASS = 0;
const TERRAIN_DIRT = 1;
const TERRAIN_SIDEWALK = 2;
const TERRAIN_WATER = 3;
const TERRAIN_ROAD = 4;

/** The four Wang sheets, each joining a lower and an upper terrain. */
const PIXEL_TERRAIN_SETS = [
  { file: "terrain-grass-dirt", lower: TERRAIN_GRASS, upper: TERRAIN_DIRT },
  { file: "terrain-grass-sidewalk", lower: TERRAIN_GRASS, upper: TERRAIN_SIDEWALK },
  { file: "terrain-grass-water", lower: TERRAIN_GRASS, upper: TERRAIN_WATER },
  { file: "terrain-sidewalk-road", lower: TERRAIN_SIDEWALK, upper: TERRAIN_ROAD },
] as const;

/** Road widths in metres when OpenStreetMap doesn't say. */
const PIXEL_ROAD_WIDTH: Record<string, number> = {
  motorway: 16, trunk: 14, primary: 12, secondary: 11, tertiary: 9, unclassified: 7,
  residential: 7.5, living_street: 5, service: 4.5, busway: 7, road: 7,
};

type PixelLatLng = [number, number];

interface PixelMapData {
  buildings: {
    id: number;
    ring: PixelLatLng[];
    levels: number | null;
    height: number | null;
    kind: string;
    name: string | null;
    mcgill: boolean;
  }[];
  roads: { kind: string; name: string | null; lanes: number | null; width: number | null; pts: PixelLatLng[] }[];
  paths: { sidewalk: boolean; dirt: boolean; pts: PixelLatLng[] }[];
  areas: { kind: "grass" | "paved" | "dirt" | "water"; ring: PixelLatLng[] }[];
}

interface PixelTerrainSheet {
  tiles: { corners: { NW: string; NE: string; SW: string; SE: string }; rect: [number, number, number, number] }[];
}

interface PixelVariant {
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min_w: number;
  bay: { x: number; w: number; max_remove: number };
  fill_cols: number[];
  roof_rows: [number, number];
  floors: { y: number; h: number } | null;
  facade_share: number | null;
  roof_base: string;
  speck: string;
  speck_density: number;
  clean_row: string[];
}

interface PixelBuilding {
  /** OpenStreetMap id (negative for buildings added in public/map-edits.json). */
  id: number;
  /** Top-left corner and size on the art grid, relative to the grid origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A downtown variant id (A1 ... D3), or "roof" for the roof-and-wall look. */
  look: string;
  /** Its OpenStreetMap name, if it has one. */
  name: string | null;
  sprite: HTMLCanvasElement | null;
}

interface PixelProp {
  kind: "tree" | "bush" | "street_lamp" | "bench";
  /** Top-left and size on the art grid, relative to the grid origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Hand edits to the map (public/map-edits.json); positions are absolute art-grid pixels, so
 * they don't move when the area outline changes.
 */
interface PixelMapEdits {
  version: 1;
  buildings: Record<string, { x: number; y: number; w: number; h: number; look: string; removed?: boolean; added?: boolean }>;
  /** Tile-corner terrain by "column,row" on the absolute art grid. */
  terrain: Record<string, number>;
  /** Tiles with a fence, by "column,row" (the tile's top-left corner) on the absolute art grid. */
  fences?: Record<string, 1>;
}

/** Where a street's name can go: art-grid point (relative to the origin) and direction. */
interface PixelStreetLabel {
  name: string;
  /** 0 main streets, 1 secondary, 2 the rest: main streets get their labels first. */
  rank: number;
  spots: { x: number; y: number; vertical: boolean }[];
}

/**
 * Extra art drawn on top of a named building's roof (centred, sitting on the roof's middle),
 * e.g. the Arts Building's cupola. scale is a whole number, so pixels stay square. Add a line
 * to give another building a topper.
 */
const PIXEL_ROOF_TOPPERS: { building: string; image: string; scale: number }[] = [
  { building: "Arts Building", image: "/tiles/arts-cupola.png", scale: 3 },
];

/** Where a topper goes on a building sprite: left, top and size in art pixels. */
function topperRect(b: { w: number; h: number }, img: { width: number; height: number }, scale: number) {
  const w = img.width * scale;
  const h = img.height * scale;
  // Base a little below the middle of the roof (the front wall is the bottom 32 px).
  const base = Math.round((b.h - 32) / 2) + 6 * scale;
  return { x: Math.round((b.w - w) / 2), y: Math.max(0, base - h), w, h };
}

/** Label zooms: streets from LABEL_STREET_ZOOM, building names from LABEL_BUILDING_ZOOM. */
const LABEL_STREET_ZOOM = 17;
const LABEL_BUILDING_ZOOM = 18;
/** Label text size in CSS pixels: never smaller than LABEL_MIN_PX, up to LABEL_MAX_PX zoomed in. */
const LABEL_MIN_PX = 12;
const LABEL_MAX_PX = 16;
/** The same street's name is never repeated closer than this many screen pixels. */
const LABEL_REPEAT_PX = 420;

/**
 * A name as crisp pixel text: drawn small, made hard-edged (no half-transparent pixels), then
 * given a 1 px dark outline so it reads on grass, roofs and asphalt alike. Vertical labels are
 * turned a quarter turn, reading bottom to top.
 */
function pixelLabel(text: string, colour: string, vertical: boolean, fontPx: number): HTMLCanvasElement {
  const font = `700 ${fontPx}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const spacing = fontPx >= 13 ? "1px" : "0.5px";
  const mctx = pixelCanvas(1, 1)[1];
  mctx.font = font;
  mctx.letterSpacing = spacing;
  const w = Math.ceil(mctx.measureText(text).width) + 6;
  const h = fontPx + 7;
  const [c, ctx] = pixelCanvas(w, h);
  ctx.font = font;
  ctx.letterSpacing = spacing;
  ctx.textBaseline = "middle";
  ctx.fillStyle = colour;
  ctx.fillText(text, 3, h / 2);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Hard pixels: a lowish cut-off keeps thin strokes whole instead of breaking them up.
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3]! >= 80 ? 1 : 0;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
  const [cr, cg, cb] = pixelHex(`${colour}ff`);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (solid[i]) {
        d.set([cr, cg, cb, 255], i * 4);
        continue;
      }
      // A 1 px dark outline all round, plus a shadow pixel down and to the right (light from
      // the top-left, like the rest of the art), so the text stands off grass, roofs and roads.
      let ring = false;
      for (let dy = -1; dy <= 1 && !ring; dy++) for (let dx = -1; dx <= 1 && !ring; dx++) ring = (dx !== 0 || dy !== 0) && at(x + dx, y + dy);
      const shadow = !ring && (at(x - 1, y - 2) || at(x - 2, y - 2) || at(x - 2, y - 1));
      d.set(ring ? [46, 34, 47, 255] : shadow ? [46, 34, 47, 150] : [0, 0, 0, 0], i * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  if (!vertical) return c;
  const [v, vctx] = pixelCanvas(h, w);
  vctx.translate(0, w);
  vctx.rotate(-Math.PI / 2);
  vctx.drawImage(c, 0, 0);
  return v;
}

/**
 * Smooth patchy noise in [0, 1) for a tile: random values on a lattice every 6 tiles, blended
 * smoothly between them, so values come in soft blobs rather than salt-and-pepper.
 */
function pixelPatchNoise(x: number, y: number): number {
  const S = 6;
  const gx = Math.floor(x / S);
  const gy = Math.floor(y / S);
  const fx = x / S - gx;
  const fy = y / S - gy;
  const v = (ix: number, iy: number) => pixelHash(Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ 0x5eed) / 4294967296;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(gx, gy) + (v(gx + 1, gy) - v(gx, gy)) * sx;
  const bottom = v(gx, gy + 1) + (v(gx + 1, gy + 1) - v(gx, gy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** What a building is, for hover names when it has no name of its own. */
function lookName(look: string): string {
  return { A: "Rowhouses", B: "Walk-up apartments", C: "Office building", D: "Tower" }[look[0]!] ?? "McGill building";
}

interface PixelWorldOptions {
  /** Map bearing in degrees (MAP_ROTATION). */
  bearing: number;
  /** The area outlines the layer fills, each a list of [lat, lng] points. */
  rings: [number, number][][];
  isInArea: (lat: number, lng: number) => boolean;
}

/** "#rrggbbaa" to [r, g, b, a]. */
function pixelHex(hex: string): [number, number, number, number] {
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length >= 9 ? n(7) : 255];
}

/** Small stable hash, so a building keeps its look between visits. */
function pixelHash(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function pixelLoadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${src}`));
    img.src = src;
  });
}

function pixelImageData(img: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function pixelCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  return [canvas, canvas.getContext("2d")!];
}

/**
 * Stretches a downtown building to w x h art pixels, following buildings-downtown.json:
 * repeat or drop a window bay (then single plain columns) for width; grow the front wall by
 * whole floors and the roof by plain roof for depth.
 */
function stretchBuilding(sheet: ImageData, v: PixelVariant, W: number, H: number, seed: number): ImageData {
  const sw = sheet.width;
  const src = sheet.data;
  const at = (x: number, y: number) => ((v.y + y) * sw + (v.x + x)) * 4;

  // Columns: [source x, added?]
  let xs: [number, boolean][] = Array.from({ length: v.w }, (_, x): [number, boolean] => [x, false]);
  const { x: bx, w: bw, max_remove } = v.bay;
  const dW = W - v.w;
  if (dW > 0) {
    const copies: [number, boolean][] = [];
    for (let k = 0; k < Math.floor(dW / bw); k++) for (let x = bx; x < bx + bw; x++) copies.push([x, true]);
    xs = [...xs.slice(0, bx + bw), ...copies, ...xs.slice(bx + bw)];
  } else if (dW < 0) {
    const k = Math.min(max_remove, Math.floor(-dW / bw));
    xs = [...xs.slice(0, bx), ...xs.slice(bx + k * bw)];
  }
  let rem = W - xs.length;
  for (let i = 0; rem > 0 && v.fill_cols.length > 0; i++, rem--) {
    const c = v.fill_cols[i % v.fill_cols.length]!;
    const j = xs.findIndex(([x]) => x === c);
    if (j >= 0) xs.splice(j, 0, [c, true]);
  }
  for (let i = 0; rem < 0 && xs.length > 16; i++) {
    const live = xs.map(([x], j) => (v.fill_cols.includes(x) ? j : -1)).filter((j) => j >= 0);
    if (live.length === 0) break;
    xs.splice(live[i % live.length]!, 1);
    rem++;
  }

  // Rows: source y, or null for new plain roof.
  const [rt, rb] = v.roof_rows;
  let ys: (number | null)[] = Array.from({ length: v.h }, (_, y) => y);
  let dH = H - v.h;
  if (dH > 0 && v.floors && v.facade_share) {
    const { y: fy, h: fh } = v.floors;
    const want = Math.floor(H * v.facade_share) - (v.h - rb);
    const k = Math.max(0, Math.floor(Math.min(dH, want) / fh));
    const floors: number[] = [];
    for (let i = 0; i < k; i++) for (let y = fy; y < fy + fh; y++) floors.push(y);
    ys = [...ys.slice(0, fy + fh), ...floors, ...ys.slice(fy + fh)];
    dH -= k * fh;
  }
  if (dH > 0) ys = [...ys.slice(0, rb), ...new Array<null>(dH).fill(null), ...ys.slice(rb)];
  else if (dH < 0) {
    const drop = Math.min(-dH, rb - rt - 2);
    ys = [...ys.slice(0, rt + 1), ...ys.slice(rt + 1 + drop)];
  }

  const base = pixelHex(v.roof_base);
  const speck = pixelHex(v.speck);
  const clean = v.clean_row.map(pixelHex);
  const isBase = (c: number[]) => c[0] === base[0] && c[1] === base[1] && c[2] === base[2] && c[3] === base[3];
  const out = new ImageData(xs.length, ys.length);
  const o = out.data;
  for (let oy = 0; oy < ys.length; oy++) {
    const sy = ys[oy]!;
    for (let ox = 0; ox < xs.length; ox++) {
      const [sx, added] = xs[ox]!;
      const i = (oy * xs.length + ox) * 4;
      let c: ArrayLike<number>;
      if (sy === null || (added && sy >= rt && sy <= rb)) {
        const cr = clean[sx]!;
        if (!isBase(cr)) c = cr;
        else {
          const h = (Math.imul(ox, 73856093) ^ Math.imul(oy, 19349663) ^ seed) & 0xffff;
          c = h < v.speck_density * 65536 ? speck : base;
        }
      } else {
        const j = at(sx, sy);
        c = [src[j]!, src[j + 1]!, src[j + 2]!, src[j + 3]!];
      }
      o[i] = c[0]!;
      o[i + 1] = c[1]!;
      o[i + 2] = c[2]!;
      o[i + 3] = c[3]!;
    }
  }
  return out;
}

/** The copper roof (roofs.png, a 3x3 set of 16 px tiles) stretched over w x h. */
function stretchRoof(roof: ImageData, W: number, H: number): ImageData {
  const pick = (p: number, size: number) => {
    if (p < 16 && p < size / 2) return p;
    if (size - p <= 16 && p >= size / 2) return 48 - (size - p);
    return 16 + ((p - 16) % 16);
  };
  const out = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    const sy = pick(y, H);
    for (let x = 0; x < W; x++) {
      const sx = pick(x, W);
      const i = (y * W + x) * 4;
      const j = (sy * roof.width + sx) * 4;
      out.data[i] = roof.data[j]!;
      out.data[i + 1] = roof.data[j + 1]!;
      out.data[i + 2] = roof.data[j + 2]!;
      out.data[i + 3] = roof.data[j + 3]!;
    }
  }
  return out;
}

/**
 * Roof colours for roof-and-wall buildings: copper as drawn, plus grey slate and red clay made
 * by swapping the copper's colours for others in Resurrect 64 (copper colour -> new colour).
 */
const PIXEL_ROOF_COLOURS: Record<string, string>[] = [
  {},
  { "0eaf9b": "7f708a", "165a4c": "2e222f", "92a984": "9babb2", "0b8a8f": "625565", "547e64": "625565", "30e1b9": "c7dcd0", "0b5e65": "3e3546", "239063": "694f62", "374e4a": "3e3546", "8ff8e2": "ffffff" },
  { "0eaf9b": "b33831", "165a4c": "45293f", "92a984": "cd683d", "0b8a8f": "9e4539", "547e64": "7a3045", "30e1b9": "e6904e", "0b5e65": "6e2727", "239063": "7a3045", "374e4a": "6e2727", "8ff8e2": "fbb954" },
];

/**
 * Buildings whose roof colour is fixed instead of picked from their id: an index into
 * PIXEL_ROOF_COLOURS (0 green copper, 1 grey slate, 2 red clay).
 */
const PIXEL_ROOF_BY_BUILDING: Record<string, number> = {
  "Arts Building": 0,
};

/** The roof sheet with one of PIXEL_ROOF_COLOURS applied. */
function recolourRoof(roof: ImageData, swaps: Record<string, string>): ImageData {
  const out = new ImageData(new Uint8ClampedArray(roof.data), roof.width, roof.height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const hex = ((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!).toString(16).padStart(6, "0");
    const to = swaps[hex];
    if (to) {
      const n = Number.parseInt(to, 16);
      d[i] = n >> 16;
      d[i + 1] = (n >> 8) & 255;
      d[i + 2] = n & 255;
    }
  }
  return out;
}

/**
 * A roof-and-wall building: the copper roof on top, and along the bottom (the side the camera
 * sees) a 2-tile front wall from walls.png (64x32: left end, repeating middle, right end, door),
 * with the door in the middle column.
 */
function roofAndWall(roof: ImageData, walls: ImageData, W: number, H: number, seed = 0): ImageData {
  const wallH = Math.min(32, H - 16);
  const out = stretchRoof(roof, W, H - wallH); // ends in the roof's dark eave, right above the wall
  const full = new ImageData(W, H);
  full.data.set(out.data);
  const cols = W / PIXEL_TILE;
  // The door goes in one of the middle columns, picked per building.
  const door = cols <= 2 ? 1 : 1 + (seed % (cols - 2));
  for (let c = 0; c < cols; c++) {
    const piece = c === 0 ? 0 : c === cols - 1 ? 2 : c === door ? 3 : 1;
    for (let y = 0; y < wallH; y++) {
      for (let x = 0; x < PIXEL_TILE; x++) {
        const j = ((y + 32 - wallH) * walls.width + piece * PIXEL_TILE + x) * 4;
        const i = ((H - wallH + y) * W + c * PIXEL_TILE + x) * 4;
        full.data.set(walls.data.subarray(j, j + 4), i);
      }
    }
  }
  return full;
}

/** Which downtown type a footprint gets: A rowhouse, B walk-up, C mid-rise, D tower. */
function downtownType(areaM2: number, b: PixelMapData["buildings"][number]): string {
  const levels = b.levels ?? 0;
  const height = b.height ?? 0;
  if (levels > 12 || height > 40 || areaM2 > 2500) return "D";
  if (levels >= 6 || areaM2 > 800 || /^(office|commercial|hotel|hospital)$/.test(b.kind)) return "C";
  if (areaM2 > 220 || b.kind === "apartments") return "B";
  return "A";
}

/**
 * Makes the area box the whole explorable map: no zooming out past the zoom where the box
 * covers the view, and no dragging past its edges, so nothing outside it is ever drawn or
 * fetched. The box is square to the rotated street grid, so the checks use that frame (the
 * zoom-19 projection turned by the bearing). Returns the widest zoom allowed.
 */
function limitViewToArea(map: L.Map, rings: [number, number][][], bearing: number): number {
  const angle = (bearing * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const toGrid = (lat: number, lng: number): [number, number] => {
    const p = map.project([lat, lng], PIXEL_ZOOM);
    return [p.x * cos - p.y * sin, p.x * sin + p.y * cos];
  };
  const fromGrid = (gx: number, gy: number) => map.unproject([gx * cos + gy * sin, -gx * sin + gy * cos], PIXEL_ZOOM);
  const pts = rings.flat().map(([lat, lng]) => toGrid(lat, lng));
  const box = {
    left: Math.min(...pts.map((p) => p[0])),
    right: Math.max(...pts.map((p) => p[0])),
    top: Math.min(...pts.map((p) => p[1])),
    bottom: Math.max(...pts.map((p) => p[1])),
  };
  const coverZoom = () => {
    const size = map.getSize();
    const fit = Math.min((box.right - box.left) / size.x, (box.bottom - box.top) / size.y);
    return Math.ceil((PIXEL_ZOOM - Math.log2(fit)) * 4) / 4;
  };
  let busy = false;
  const keepInside = () => {
    if (busy) return;
    const size = map.getSize();
    const scale = 2 ** (PIXEL_ZOOM - map.getZoom());
    const halfW = (size.x / 2) * scale;
    const halfH = (size.y / 2) * scale;
    const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    const c = map.getCenter();
    const [gx, gy] = toGrid(c.lat, c.lng);
    const nx = clamp(gx, box.left + halfW, box.right - halfW);
    const ny = clamp(gy, box.top + halfH, box.bottom - halfH);
    if (Math.abs(nx - gx) < 0.5 && Math.abs(ny - gy) < 0.5) return;
    busy = true;
    map.setView(fromGrid(nx, ny), map.getZoom(), { animate: false });
    busy = false;
  };
  map.setMinZoom(coverZoom());
  if (map.getZoom() < coverZoom()) map.setZoom(coverZoom(), { animate: false });
  map.on("resize", () => map.setMinZoom(coverZoom()));
  map.on("drag zoomend moveend resize", keepInside);
  keepInside();
  return coverZoom();
}

class PixelWorld {
  private readonly map: L.Map;
  private readonly opts: PixelWorldOptions;
  private readonly cos: number;
  private readonly sin: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private ready = false;
  private animating = false;
  private drawQueued = false;
  private baseTransform = "";

  // Art grid: origin (multiple of a tile) and size in tiles.
  private ox = 0;
  private oy = 0;
  private cols = 0;
  private rows = 0;
  private chunkCols = 0;
  private chunkRows = 0;
  /** One tile id per tile: set index * 16 + corner key (NW 8, NE 4, SW 2, SE 1; 1 = upper). */
  private tileIds = new Uint8Array(0);
  /** Whole-grass tiles drawn with the darker grass (1), per tile. */
  private darkGrass = new Uint8Array(0);
  /** The darker grass tile at each mip level. */
  private darkGrassBlocks: Uint8ClampedArray[] = [];
  /** Pixels of each tile id at each mip level. */
  private tileBlocks: Uint8ClampedArray[][] = [];
  private buildings: PixelBuilding[] = [];
  private chunkBuildings = new Map<number, PixelBuilding[]>();
  private variants: Record<string, PixelVariant> = {};
  private buildingSheet: ImageData | null = null;
  private roofSheet: ImageData | null = null;
  private wallSheet: ImageData | null = null;
  /** The roof in each of PIXEL_ROOF_COLOURS. */
  private roofSheets: ImageData[] = [];
  private chunks = new Map<string, HTMLCanvasElement>();
  private cacheBytes = 0;
  /** The whole world at one pixel per tile, shown wherever a chunk isn't drawn yet. */
  private overview: HTMLCanvasElement | null = null;
  private edits: PixelMapEdits = { version: 1, buildings: {}, terrain: {} };
  /** Tile-corner terrain, (cols + 1) x (rows + 1). */
  private corner = new Uint8Array(0);
  /** Tiles with a fence (index y * cols + x). */
  private fences = new Set<number>();
  private fenceImage: HTMLImageElement | null = null;
  private props: PixelProp[] = [];
  private chunkProps = new Map<number, PixelProp[]>();
  private propImage: HTMLImageElement | null = null;
  private propRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
  /** Roof topper images and scales by building name (PIXEL_ROOF_TOPPERS). */
  private toppers = new Map<string, { img: HTMLImageElement; scale: number }>();
  private streetLabels: PixelStreetLabel[] = [];
  /** Named road segments on the art grid, for hover names. */
  private roadSegments: { name: string; ax: number; ay: number; bx: number; by: number }[] = [];
  private labelCache = new Map<string, HTMLCanvasElement>();
  private readonly tooltip: HTMLDivElement;

  constructor(map: L.Map, opts: PixelWorldOptions) {
    this.map = map;
    this.opts = opts;
    const a = (opts.bearing * Math.PI) / 180;
    this.cos = Math.cos(a);
    this.sin = Math.sin(a);

    // Inside the rotated pane, between the map tiles (200) and route lines (400).
    const pane = map.createPane("pixelWorld", map.getPane("rotatePane"));
    pane.style.zIndex = "300";
    pane.style.pointerEvents = "none";
    [this.canvas, this.ctx] = pixelCanvas(1, 1);
    this.canvas.className = "pixel-world leaflet-zoom-animated";
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.transformOrigin = "0 0";
    this.canvas.style.imageRendering = "pixelated";
    pane.append(this.canvas);

    // Hover names: a small tag that follows the mouse over buildings and streets.
    this.tooltip = document.createElement("div");
    this.tooltip.className = "pixel-hover-name";
    this.tooltip.hidden = true;
    map.getContainer().append(this.tooltip);
    let hoverQueued = false;
    let lastMove: MouseEvent | null = null;
    map.getContainer().addEventListener("mousemove", (e) => {
      lastMove = e;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        if (lastMove) this.hover(lastMove);
      });
    });
    map.getContainer().addEventListener("mouseleave", () => (this.tooltip.hidden = true));
    map.on("movestart zoomstart", () => (this.tooltip.hidden = true));

    map.on("move zoom viewreset resize", () => this.queueDraw());
    map.on("zoomanim", (e) => this.onZoomAnim(e as L.ZoomAnimEvent));
    map.on("zoomend", () => {
      this.animating = false;
      this.queueDraw();
    });
  }

  /** Loads the art and the map data for the box, then starts drawing. */
  async start(bounds: L.LatLngBounds): Promise<void> {
    const params = new URLSearchParams({
      south: bounds.getSouth().toFixed(4),
      west: bounds.getWest().toFixed(4),
      north: bounds.getNorth().toFixed(4),
      east: bounds.getEast().toFixed(4),
    });
    const json = <T>(url: string) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.json() as Promise<T>;
      });
    const sprites = (url: string) => json<{ sprites: Record<string, { x: number; y: number; w: number; h: number }> }>(url).then((p) => p.sprites);
    // Everything at once; the hand edits and the fence art are optional.
    const [data, sheets, sheetImgs, buildingsJson, buildingImg, roofImg, wallImg, propImg, propRects, edits, fenceImg] = await Promise.all([
      json<PixelMapData>(`/api/mapdata?${params}&v=2`), // v: the data's shape, so an old cached answer isn't reused
      Promise.all(PIXEL_TERRAIN_SETS.map((s) => json<PixelTerrainSheet>(`/tiles/${s.file}.json`))),
      Promise.all(PIXEL_TERRAIN_SETS.map((s) => pixelLoadImage(`/tiles/${s.file}.png`))),
      json<{ variants: Record<string, PixelVariant> }>("/tiles/buildings-downtown.json"),
      pixelLoadImage("/tiles/buildings-downtown.png"),
      pixelLoadImage("/tiles/roofs.png"),
      pixelLoadImage("/tiles/walls.png"),
      pixelLoadImage("/tiles/props.png"),
      sprites("/tiles/props.json"),
      json<PixelMapEdits>("/map-edits.json").catch(() => null),
      pixelLoadImage("/tiles/fence.png").catch(() => null),
    ]);
    // Roof toppers are decoration: one that doesn't load is just left off.
    for (const t of PIXEL_ROOF_TOPPERS) {
      void pixelLoadImage(t.image).then((img) => {
        this.toppers.set(t.building, { img, scale: t.scale });
        for (const b of this.buildings) if (b.name === t.building) b.sprite = null;
        this.chunks.clear();
        this.cacheBytes = 0;
        this.queueDraw();
      }, () => undefined);
    }
    if (edits) this.edits = edits;
    this.fenceImage = fenceImg;
    this.propImage = propImg;
    this.propRects = propRects;
    this.variants = buildingsJson.variants;
    this.buildingSheet = pixelImageData(buildingImg);
    this.roofSheet = pixelImageData(roofImg);
    this.wallSheet = pixelImageData(wallImg);
    this.roofSheets = PIXEL_ROOF_COLOURS.map((swaps) => recolourRoof(this.roofSheet!, swaps));
    this.buildTileBlocks(sheets, sheetImgs.map(pixelImageData));
    // The darker grass: the same tile, a fifth darker, so it keeps the grass's pattern and hue.
    this.darkGrassBlocks = (this.tileBlocks[0] ?? []).map((block) => {
      const d = new Uint8ClampedArray(block);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i]! * 0.78;
        d[i + 1] = d[i + 1]! * 0.84;
        d[i + 2] = d[i + 2]! * 0.74;
      }
      return d;
    });
    this.buildWorld(data);
    this.overview = this.renderOverview();
    this.ready = true;
    this.queueDraw();
  }

  // -------------------------------------------------------------------------
  // Coordinates

  /** Art-grid coordinates of a point: the zoom-19 projection rotated by the bearing. */
  private toGrid(lat: number, lng: number): [number, number] {
    const p = this.map.project([lat, lng], PIXEL_ZOOM);
    return [p.x * this.cos - p.y * this.sin, p.x * this.sin + p.y * this.cos];
  }

  // -------------------------------------------------------------------------
  // Terrain

  private buildTileBlocks(sheets: PixelTerrainSheet[], images: ImageData[]): void {
    this.tileBlocks = [];
    sheets.forEach((sheet, s) => {
      const img = images[s]!;
      for (const tile of sheet.tiles) {
        const c = tile.corners;
        const key = (c.NW === "upper" ? 8 : 0) | (c.NE === "upper" ? 4 : 0) | (c.SW === "upper" ? 2 : 0) | (c.SE === "upper" ? 1 : 0);
        const [rx, ry] = tile.rect;
        const levels: Uint8ClampedArray[] = [];
        for (let level = 0; level <= PIXEL_MAX_LEVEL; level++) {
          const f = 1 << level;
          const b = PIXEL_TILE / f;
          const block = new Uint8ClampedArray(b * b * 4);
          for (let y = 0; y < b; y++) {
            for (let x = 0; x < b; x++) {
              const sum = [0, 0, 0, 0];
              for (let dy = 0; dy < f; dy++) {
                for (let dx = 0; dx < f; dx++) {
                  const j = ((ry + y * f + dy) * img.width + (rx + x * f + dx)) * 4;
                  for (let k = 0; k < 4; k++) sum[k]! += img.data[j + k]!;
                }
              }
              for (let k = 0; k < 4; k++) block[(y * b + x) * 4 + k] = sum[k]! / (f * f);
            }
          }
          levels.push(block);
        }
        this.tileBlocks[s * 16 + key] = levels;
      }
    });
  }

  private buildWorld(data: PixelMapData): void {
    const ringGrid = this.opts.rings.flat().map(([lat, lng]) => this.toGrid(lat, lng));
    const minX = Math.min(...ringGrid.map((p) => p[0])) - 2 * PIXEL_TILE;
    const minY = Math.min(...ringGrid.map((p) => p[1])) - 2 * PIXEL_TILE;
    const maxX = Math.max(...ringGrid.map((p) => p[0])) + 2 * PIXEL_TILE;
    const maxY = Math.max(...ringGrid.map((p) => p[1])) + 2 * PIXEL_TILE;
    this.ox = Math.floor(minX / PIXEL_TILE) * PIXEL_TILE;
    this.oy = Math.floor(minY / PIXEL_TILE) * PIXEL_TILE;
    this.cols = Math.ceil((maxX - this.ox) / PIXEL_TILE);
    this.rows = Math.ceil((maxY - this.oy) / PIXEL_TILE);
    this.chunkCols = Math.ceil(this.cols / PIXEL_CHUNK_TILES);
    this.chunkRows = Math.ceil(this.rows / PIXEL_CHUNK_TILES);

    const lat0 = this.opts.rings[0]![0]![0];
    /** Metres per art pixel. */
    const mpp = (156543.03392 * Math.cos((lat0 * Math.PI) / 180)) / 2 ** PIXEL_ZOOM;
    const vw = this.cols + 1;
    const vh = this.rows + 1;
    const corner = new Uint8Array(vw * vh).fill(TERRAIN_GRASS);
    const toVertex = (pts: PixelLatLng[]) =>
      pts.map(([lat, lng]): [number, number] => {
        const [gx, gy] = this.toGrid(lat, lng);
        return [(gx - this.ox) / PIXEL_TILE, (gy - this.oy) / PIXEL_TILE];
      });

    const fillPolygon = (pts: [number, number][], terrain: number, target = corner) => {
      const ys = pts.map((p) => p[1]);
      const y0 = Math.max(0, Math.ceil(Math.min(...ys)));
      const y1 = Math.min(vh - 1, Math.floor(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) {
        const xs: number[] = [];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i]!;
          const [xj, yj] = pts[j]!;
          if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xs[k]!));
          const xb = Math.min(vw - 1, Math.floor(xs[k + 1]!));
          for (let x = xa; x <= xb; x++) target[y * vw + x] = terrain;
        }
      }
    };
    const strokeLine = (pts: [number, number][], halfWidth: number, terrain: number, keep?: number) => {
      const r = halfWidth / PIXEL_TILE;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
        const x1 = Math.min(vw - 1, Math.ceil(Math.max(ax, bx) + r));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
        const y1 = Math.min(vh - 1, Math.ceil(Math.max(ay, by) + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
            const ex = ax + t * dx - x;
            const ey = ay + t * dy - y;
            if (ex * ex + ey * ey <= r * r && corner[y * vw + x] !== keep) corner[y * vw + x] = terrain;
          }
        }
      }
    };
    const polyArea = (pts: [number, number][]) => {
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
      return Math.abs(a / 2);
    };

    // Ground areas, biggest first, so a plaza inside a park (or a lawn in a plaza) wins.
    const terrainOf = { grass: TERRAIN_GRASS, paved: TERRAIN_SIDEWALK, dirt: TERRAIN_DIRT, water: TERRAIN_WATER };
    const areas = data.areas.map((a) => ({ pts: toVertex(a.ring), terrain: terrainOf[a.kind] }));
    areas.sort((a, b) => polyArea(b.pts) - polyArea(a.pts));
    for (const a of areas) fillPolygon(a.pts, a.terrain);

    // Paving under buildings, so no grass shows through at their edges. Not under McGill's
    // roof-and-wall buildings: they're drawn smaller than their footprint, on their lawn.
    const footprints = data.buildings.map((b) => ({ b, pts: toVertex(b.ring) }));

    // Where the darker grass grows thickest: big green areas (the mountain, parks, campus lawns)
    // and around McGill's buildings. Elsewhere it only shows in a few patches.
    const lush = new Uint8Array(vw * vh);
    for (const a of areas) if (a.terrain === TERRAIN_GRASS && polyArea(a.pts) > 500) fillPolygon(a.pts, 1, lush);
    const R = 20; // tiles around each McGill building
    for (const f of footprints) {
      if (!f.b.mcgill) continue;
      const cx = Math.round(f.pts.reduce((t, p) => t + p[0], 0) / f.pts.length);
      const cy = Math.round(f.pts.reduce((t, p) => t + p[1], 0) / f.pts.length);
      for (let y = Math.max(0, cy - R); y <= Math.min(vh - 1, cy + R); y++) {
        for (let x = Math.max(0, cx - R); x <= Math.min(vw - 1, cx + R); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) lush[y * vw + x] = 1;
      }
    }
    for (const f of footprints) if (!f.b.mcgill) fillPolygon(f.pts, TERRAIN_SIDEWALK);

    // Paths, then roads on top (crosswalks aren't drawn, so roads stay whole).
    const pathHalf = Math.max(1.5 / mpp, 8.5);
    for (const p of data.paths) strokeLine(toVertex(p.pts), pathHalf, p.dirt ? TERRAIN_DIRT : TERRAIN_SIDEWALK, TERRAIN_ROAD);
    for (const road of data.roads) {
      const metres = road.width ?? (road.lanes ? road.lanes * 3.2 + 1 : PIXEL_ROAD_WIDTH[road.kind.replace(/_link$/, "")] ?? 7);
      strokeLine(toVertex(road.pts), Math.max(metres / 2 / mpp, 8.5), TERRAIN_ROAD);
    }

    // Make every tile drawable with the four sheets: roads only meet sidewalk, dirt and water
    // only meet grass.
    const neighbours = (x: number, y: number, test: (t: number) => boolean) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < vw && ny < vh && test(corner[ny * vw + nx]!)) return true;
        }
      }
      return false;
    };
    const roadEdge: number[] = [];
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        if (corner[y * vw + x] !== TERRAIN_ROAD && neighbours(x, y, (t) => t === TERRAIN_ROAD)) roadEdge.push(y * vw + x);
      }
    }
    for (const i of roadEdge) corner[i] = TERRAIN_SIDEWALK;
    // Map-data scraps: a sidewalk or dirt corner with at most one paved neighbour is a lone
    // square or the tip of a stub. Three passes clear stubs up to three corners long.
    for (let pass = 0; pass < 3; pass++) {
      const drop: number[] = [];
      for (let y = 0; y < vh; y++) {
        for (let x = 0; x < vw; x++) {
          const t = corner[y * vw + x];
          if (t !== TERRAIN_SIDEWALK && t !== TERRAIN_DIRT) continue;
          let paved = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx;
            const ny = y + dy;
            const n = nx >= 0 && ny >= 0 && nx < vw && ny < vh ? corner[ny * vw + nx]! : TERRAIN_SIDEWALK;
            if (n === TERRAIN_SIDEWALK || n === TERRAIN_DIRT || n === TERRAIN_ROAD) paved++;
          }
          if (paved <= 1) drop.push(y * vw + x);
        }
      }
      for (const i of drop) corner[i] = TERRAIN_GRASS;
    }
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const t = corner[y * vw + x];
        if (t === TERRAIN_DIRT && neighbours(x, y, (n) => n === TERRAIN_SIDEWALK || n === TERRAIN_ROAD)) corner[y * vw + x] = TERRAIN_GRASS;
        else if (t === TERRAIN_WATER && neighbours(x, y, (n) => n !== TERRAIN_WATER && n !== TERRAIN_GRASS)) corner[y * vw + x] = TERRAIN_GRASS;
      }
    }

    // Hand-painted corners from the map editor go on top.
    for (const [key, t] of Object.entries(this.edits.terrain)) {
      const [c, r] = key.split(",").map(Number);
      const x = c! - this.ox / PIXEL_TILE;
      const y = r! - this.oy / PIXEL_TILE;
      if (x >= 0 && y >= 0 && x < vw && y < vh) corner[y * vw + x] = t;
    }
    this.corner = corner;
    this.fences.clear();
    for (const key of Object.keys(this.edits.fences ?? {})) {
      const [c, r] = key.split(",").map(Number);
      const x = c! - this.ox / PIXEL_TILE;
      const y = r! - this.oy / PIXEL_TILE;
      if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) this.fences.add(y * this.cols + x);
    }
    this.tileIds = new Uint8Array(this.cols * this.rows);
    this.retile(0, 0, this.cols - 1, this.rows - 1);
    this.darkGrass = new Uint8Array(this.cols * this.rows);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        // Only whole-grass tiles (grass-dirt sheet, all corners lower): edge tiles keep the usual grass.
        if (this.tileIds[y * this.cols + x] !== 0) continue;
        const odds = lush[y * vw + x] ? 0.72 : 0.1;
        if (pixelPatchNoise(x, y) < odds) this.darkGrass[y * this.cols + x] = 1;
      }
    }

    this.buildBuildings(footprints.map((f) => f.b), mpp, polyArea);
    this.placeProps();
    this.buildStreetLabels(data);
  }

  /** Spots for each named street's label, every ~400 art px along it, on long-enough stretches. */
  private buildStreetLabels(data: PixelMapData): void {
    const rankOf = (kind: string) => (/^(motorway|trunk|primary|secondary)/.test(kind) ? 0 : /^tertiary/.test(kind) ? 1 : 2);
    const byName = new Map<string, PixelStreetLabel>();
    this.roadSegments = [];
    for (const road of data.roads) {
      if (!road.name) continue;
      const pts = road.pts.map(([lat, lng]) => {
        const [gx, gy] = this.toGrid(lat, lng);
        return [gx - this.ox, gy - this.oy] as const;
      });
      const label = byName.get(road.name) ?? { name: road.name, rank: 2, spots: [] };
      label.rank = Math.min(label.rank, rankOf(road.kind));
      let along = 200; // the first label sits a little way in from the start
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        this.roadSegments.push({ name: road.name, ax, ay, bx, by });
        const len = Math.hypot(bx - ax, by - ay);
        if (len >= 120) {
          for (let t = along; t < len - 40; t += 400) {
            label.spots.push({ x: ax + ((bx - ax) * t) / len, y: ay + ((by - ay) * t) / len, vertical: Math.abs(by - ay) > Math.abs(bx - ax) });
          }
        }
        along = Math.max(40, along - len);
      }
      byName.set(road.name, label);
    }
    this.streetLabels = [...byName.values()].filter((l) => l.spots.length > 0).sort((a, b) => a.rank - b.rank);
  }

  private label(text: string, colour: string, vertical: boolean, fontPx: number): HTMLCanvasElement {
    const key = `${fontPx}|${colour}|${vertical ? "v" : "h"}|${text}`;
    let c = this.labelCache.get(key);
    if (!c) {
      c = pixelLabel(text, colour, vertical, fontPx);
      this.labelCache.set(key, c);
    }
    return c;
  }

  /**
   * Street names (from LABEL_STREET_ZOOM) and building names (from LABEL_BUILDING_ZOOM), main
   * streets first, never overlapping, and the same street's name kept LABEL_REPEAT_PX apart.
   */
  private drawLabels(ctx: CanvasRenderingContext2D, rsx: number, rsy: number, s: number, dpr: number, zoom: number, cw: number, ch: number): void {
    if (zoom < LABEL_STREET_ZOOM) return;
    // Text size on screen (CSS px): LABEL_MIN_PX at the zoom labels appear, growing to
    // LABEL_MAX_PX when zoomed in, never smaller. Drawn at that size, then scaled by a whole
    // number of screen pixels so the pixels stay crisp.
    const cssPx = Math.min(LABEL_MAX_PX, LABEL_MIN_PX + (zoom - LABEL_STREET_ZOOM) * 2);
    const k = Math.max(1, Math.round(dpr));
    const fontPx = Math.max(LABEL_MIN_PX, Math.round((cssPx * dpr) / k));
    const placed: [number, number, number, number][] = [];
    const free = (x0: number, y0: number, x1: number, y1: number) => placed.every(([a, b, c, d]) => x1 < a || x0 > c || y1 < b || y0 > d);
    const put = (img: HTMLCanvasElement, cx: number, cy: number) => {
      const w = img.width * k;
      const h = img.height * k;
      const x0 = Math.round(cx - w / 2);
      const y0 = Math.round(cy - h / 2);
      if (x0 + w < 0 || y0 + h < 0 || x0 > cw || y0 > ch || !free(x0 - 4, y0 - 4, x0 + w + 4, y0 + h + 4)) return false;
      placed.push([x0, y0, x0 + w, y0 + h]);
      ctx.drawImage(img, x0, y0, w, h);
      return true;
    };
    ctx.imageSmoothingEnabled = false;
    const repeat = LABEL_REPEAT_PX * dpr;
    for (const street of this.streetLabels) {
      const done: [number, number][] = [];
      for (const spot of street.spots) {
        const sx = rsx + spot.x * s;
        const sy = rsy + spot.y * s;
        if (sx < -200 || sy < -200 || sx > cw + 200 || sy > ch + 200) continue;
        if (done.some(([x, y]) => Math.hypot(x - sx, y - sy) < repeat)) continue;
        if (put(this.label(street.name, "#ffffff", spot.vertical, fontPx), sx, sy)) done.push([sx, sy]);
      }
    }
    if (zoom < LABEL_BUILDING_ZOOM) return;
    for (const b of this.buildings) {
      if (!b.name) continue;
      // On the roof, a third of the way down (the front wall is at the bottom); above a roof
      // topper, so the cupola or tower stays visible.
      const topper = this.toppers.get(b.name);
      const at = topper ? b.y + Math.max(8, topperRect(b, topper.img, topper.scale).y - 10) : b.y + b.h * 0.35;
      put(this.label(b.name, "#fbff86", false, Math.max(LABEL_MIN_PX, fontPx - 1)), rsx + (b.x + b.w / 2) * s, rsy + at * s);
    }
  }

  /** Shows the name of the building or street under the mouse. */
  private hover(e: MouseEvent): void {
    const tip = this.tooltip;
    const target = e.target as HTMLElement | null;
    if (!this.ready || this.map.getZoom() < PIXEL_MIN_ZOOM || target?.closest(".leaflet-marker-icon, .leaflet-popup, .leaflet-control")) {
      tip.hidden = true;
      return;
    }
    const p = this.map.mouseEventToContainerPoint(e);
    const ll = this.map.containerPointToLatLng(p);
    if (!this.opts.isInArea(ll.lat, ll.lng)) {
      tip.hidden = true;
      return;
    }
    const [gx, gy] = this.toGrid(ll.lat, ll.lng);
    const x = gx - this.ox;
    const y = gy - this.oy;
    let text: string | null = null;
    for (let i = this.buildings.length - 1; i >= 0 && !text; i--) {
      const b = this.buildings[i]!;
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) text = b.name ?? lookName(b.look);
    }
    if (!text) {
      // The nearest named street within ~18 screen pixels (about a road's width).
      const reach = 18 / this.map.getZoomScale(this.map.getZoom(), PIXEL_ZOOM);
      let best = reach * reach;
      for (const r of this.roadSegments) {
        const dx = r.bx - r.ax;
        const dy = r.by - r.ay;
        const t = Math.max(0, Math.min(1, ((x - r.ax) * dx + (y - r.ay) * dy) / (dx * dx + dy * dy || 1)));
        const ex = r.ax + t * dx - x;
        const ey = r.ay + t * dy - y;
        if (ex * ex + ey * ey < best) {
          best = ex * ex + ey * ey;
          text = r.name;
        }
      }
    }
    if (!text) {
      tip.hidden = true;
      return;
    }
    tip.textContent = text;
    tip.style.transform = `translate(${Math.round(p.x + 14)}px, ${Math.round(p.y + 12)}px)`;
    tip.hidden = false;
  }

  /**
   * Scatters props from the ground: trees on lawns (2+ tiles apart) and along sidewalks, bushes
   * beside buildings, lamps on sidewalks next to roads, benches on grass beside paths. Placement
   * comes from a hash of the tile, so it's the same on every visit.
   */
  private placeProps(): void {
    const cols = this.cols;
    const rows = this.rows;
    const vw = cols + 1;
    const c = this.corner;
    const tileIs = (x: number, y: number, t: number) =>
      x >= 0 && y >= 0 && x < cols && y < rows && c[y * vw + x] === t && c[y * vw + x + 1] === t && c[(y + 1) * vw + x] === t && c[(y + 1) * vw + x + 1] === t;
    const touches = (x: number, y: number, t: number) => {
      for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const vx = x + dx + ox;
        const vy = y + dy + oy;
        if (vx >= 0 && vy >= 0 && vx < vw && vy <= rows && c[vy * vw + vx] === t) return true;
      }
      return false;
    };
    // Tiles taken by buildings (plus a 1-tile margin) and by props already placed.
    const taken = new Uint8Array(cols * rows);
    const take = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.max(0, y0); y <= Math.min(rows - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(cols - 1, x1); x++) taken[y * cols + x] = 1;
    };
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x < 0 || y < 0 || x >= cols || y >= rows || taken[y * cols + x]) return false;
      return true;
    };
    for (const b of this.buildings) take(Math.floor(b.x / PIXEL_TILE) - 1, Math.floor(b.y / PIXEL_TILE) - 1, Math.ceil((b.x + b.w) / PIXEL_TILE), Math.ceil((b.y + b.h) / PIXEL_TILE));
    // Keep props off fences and the tile in front of them.
    for (const i of this.fences) take((i % cols) - 1, Math.floor(i / cols) - 1, (i % cols) + 1, Math.floor(i / cols) + 1);
    const roll = (x: number, y: number, salt: number) => pixelHash(x * 73856093 ^ y * 19349663 ^ salt) % 1000;
    const props: PixelProp[] = [];
    const T = PIXEL_TILE;
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (taken[y * cols + x]) continue;
        if (tileIs(x, y, TERRAIN_GRASS)) {
          const nearPath = touches(x, y, TERRAIN_SIDEWALK);
          // Trees: their canopy covers this tile and the ones around it, so keep that clear.
          const treeOdds = nearPath ? 140 : 45;
          if (roll(x, y, 1) < treeOdds && free(x - 1, y - 2, x + 1, y + 1) && tileIs(x, y - 1, TERRAIN_GRASS)) {
            props.push({ kind: "tree", x: x * T - 8, y: (y - 1) * T, w: 32, h: 32 });
            take(x - 2, y - 2, x + 2, y + 1);
            continue;
          }
          if (nearPath && roll(x, y, 2) < 25 && tileIs(x + 1, y, TERRAIN_GRASS) && free(x, y, x + 1, y)) {
            props.push({ kind: "bench", x: x * T, y: y * T, w: 32, h: 16 });
            take(x - 3, y - 1, x + 4, y + 1);
            continue;
          }
          if (roll(x, y, 3) < 60 && free(x, y, x, y)) {
            props.push({ kind: "bush", x: x * T, y: y * T, w: 16, h: 16 });
            take(x, y, x, y);
          }
        } else if (tileIs(x, y, TERRAIN_SIDEWALK) && touches(x, y, TERRAIN_ROAD) && roll(x, y, 4) < 90 && free(x - 3, y - 3, x + 3, y)) {
          props.push({ kind: "street_lamp", x: x * T, y: (y - 1) * T, w: 16, h: 32 });
          take(x - 3, y - 3, x + 3, y + 3);
        }
      }
    }
    // Bushes hug buildings: a few on the grass right in front of each one.
    const placed = new Set(props.map((p) => p.y * 65536 + p.x));
    for (const b of this.buildings) {
      const y = Math.floor((b.y + b.h) / T);
      for (let x = Math.floor(b.x / T); x < Math.ceil((b.x + b.w) / T); x++) {
        if (roll(x, y, 5) < 300 && tileIs(x, y, TERRAIN_GRASS) && !placed.has(y * T * 65536 + x * T)) {
          props.push({ kind: "bush", x: x * T, y: y * T, w: 16, h: 16 });
          placed.add(y * T * 65536 + x * T);
        }
      }
    }
    this.props = props;
    this.indexProps();
  }

  private indexProps(): void {
    this.chunkProps.clear();
    for (const p of this.props) {
      for (let cy = Math.floor(p.y / PIXEL_CHUNK); cy <= Math.floor((p.y + p.h) / PIXEL_CHUNK); cy++) {
        for (let cx = Math.floor(p.x / PIXEL_CHUNK); cx <= Math.floor((p.x + p.w) / PIXEL_CHUNK); cx++) {
          const key = cy * 10000 + cx;
          const list = this.chunkProps.get(key);
          if (list) list.push(p);
          else this.chunkProps.set(key, [p]);
        }
      }
    }
  }

  /** Recomputes the tile ids of tiles x0..x1, y0..y1 from their corners. */
  private retile(x0: number, y0: number, x1: number, y1: number): void {
    const vw = this.cols + 1;
    const corner = this.corner;
    const full = [
      [0, 0b0000], // grass: grass-dirt, all lower
      [0, 0b1111], // dirt: grass-dirt, all upper
      [1, 0b1111], // sidewalk: grass-sidewalk, all upper
      [2, 0b1111], // water: grass-water, all upper
      [3, 0b1111], // road: sidewalk-road, all upper
    ] as const;
    for (let y = Math.max(0, y0); y <= Math.min(this.rows - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.cols - 1, x1); x++) {
        const c = [corner[y * vw + x]!, corner[y * vw + x + 1]!, corner[(y + 1) * vw + x]!, corner[(y + 1) * vw + x + 1]!];
        const kinds = [...new Set(c)];
        let id: number;
        const set = kinds.length === 2 ? PIXEL_TERRAIN_SETS.findIndex((s) => kinds.includes(s.lower) && kinds.includes(s.upper)) : -1;
        if (set >= 0) {
          const upper = PIXEL_TERRAIN_SETS[set]!.upper;
          id = set * 16 + ((c[0] === upper ? 8 : 0) | (c[1] === upper ? 4 : 0) | (c[2] === upper ? 2 : 0) | (c[3] === upper ? 1 : 0));
        } else {
          const [s, key] = full[c[0]!]!;
          id = s * 16 + key;
        }
        this.tileIds[y * this.cols + x] = id;
      }
    }
  }

  private buildBuildings(
    footprints: PixelMapData["buildings"],
    mpp: number,
    polyArea: (pts: [number, number][]) => number,
  ): void {
    this.buildings = [];
    for (const b of footprints) {
      const n = b.ring.length;
      const lat = b.ring.reduce((s, p) => s + p[0], 0) / n;
      const lng = b.ring.reduce((s, p) => s + p[1], 0) / n;
      if (!this.opts.isInArea(lat, lng)) continue;
      const grid = b.ring.map(([la, ln]) => this.toGrid(la, ln));
      const fx0 = Math.min(...grid.map((p) => p[0])) - this.ox;
      const fy0 = Math.min(...grid.map((p) => p[1])) - this.oy;
      const fw = Math.max(...grid.map((p) => p[0])) - this.ox - fx0;
      const fh = Math.max(...grid.map((p) => p[1])) - this.oy - fy0;
      const areaM2 = polyArea(grid) * mpp * mpp;
      if (areaM2 < 20 || fw < 8 || fh < 8) continue;
      // Every building sits on whole tiles, like a tile-based game map.
      const snap = (v: number) => Math.round(v / PIXEL_TILE) * PIXEL_TILE;
      let w = Math.max(2 * PIXEL_TILE, snap(fw));
      let h = Math.max(2 * PIXEL_TILE, snap(fh));
      if (b.mcgill) {
        // Roof-and-wall buildings are drawn smaller than their footprint (a big roof slab reads
        // as a blank block), centred on it, 3-10 tiles wide and 3-8 tall.
        w = Math.min(10, Math.max(3, Math.round((fw * 0.7) / PIXEL_TILE))) * PIXEL_TILE;
        h = Math.min(8, Math.max(3, Math.round((fh * 0.7) / PIXEL_TILE))) * PIXEL_TILE;
      }
      const x0 = snap(fx0 + fw / 2 - w / 2);
      const y0 = snap(fy0 + fh / 2 - h / 2);
      let look = "roof";
      if (!b.mcgill) {
        const order = ["A", "B", "C", "D"];
        let type = downtownType(areaM2, b);
        let options: string[] = [];
        while (true) {
          options = Object.keys(this.variants).filter((k) => this.variants[k]!.type && k[0] === type && this.variants[k]!.min_w <= w);
          if (options.length > 0 || type === "A") break;
          type = order[order.indexOf(type) - 1]!;
        }
        if (options.length === 0) options = Object.keys(this.variants).filter((k) => k[0] === "A");
        look = options[pixelHash(b.id) % options.length]!;
      }
      const building: PixelBuilding = { id: b.id, x: x0, y: y0, w, h, look, name: b.name, sprite: null };
      const edit = this.edits.buildings[String(b.id)];
      if (edit?.removed) continue;
      if (edit) Object.assign(building, { x: edit.x - this.ox, y: edit.y - this.oy, w: edit.w, h: edit.h, look: edit.look });
      this.buildings.push(building);
    }
    this.mergeRows();
    for (const [id, edit] of Object.entries(this.edits.buildings)) {
      if (!edit.added) continue;
      this.buildings.push({ id: Number(id), x: edit.x - this.ox, y: edit.y - this.oy, w: edit.w, h: edit.h, look: edit.look, name: null, sprite: null });
    }
    this.reindex();
  }

  /**
   * Joins rows of small houses (rowhouses and walk-ups standing side by side) and cuts each row
   * into fewer, bigger buildings: about 5 tiles wide along a row that runs across the screen,
   * about 7 tiles tall along one that runs up and down. Only straight rows are joined, so a
   * block's houses never swallow its backyards. Buildings with hand edits are left alone.
   */
  private mergeRows(): void {
    const small = this.buildings.filter((b) => b.id > 0 && /^[AB]/.test(b.look) && !this.edits.buildings[String(b.id)]);
    const parent = new Map<PixelBuilding, PixelBuilding>(small.map((b) => [b, b]));
    const find = (b: PixelBuilding): PixelBuilding => {
      while (parent.get(b) !== b) b = parent.get(b)!;
      return b;
    };
    const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    // Pass 1 joins across (side by side), pass 2 joins up and down, among houses still alone.
    for (const across of [true, false]) {
      const groupSize = new Map<PixelBuilding, number>();
      for (const b of small) groupSize.set(find(b), (groupSize.get(find(b)) ?? 0) + 1);
      const pool = across ? small : small.filter((b) => groupSize.get(find(b)) === 1);
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const a = pool[i]!;
          const b = pool[j]!;
          const touch = across
            ? Math.abs(a.x + a.w - b.x) <= PIXEL_TILE || Math.abs(b.x + b.w - a.x) <= PIXEL_TILE
            : Math.abs(a.y + a.h - b.y) <= PIXEL_TILE || Math.abs(b.y + b.h - a.y) <= PIXEL_TILE;
          const shared = across ? overlap(a.y, a.y + a.h, b.y, b.y + b.h) / Math.min(a.h, b.h) : overlap(a.x, a.x + a.w, b.x, b.x + b.w) / Math.min(a.w, b.w);
          if (touch && shared >= 0.6) parent.set(find(a), find(b));
        }
      }
    }
    const rows = new Map<PixelBuilding, PixelBuilding[]>();
    for (const b of small) {
      const root = find(b);
      const row = rows.get(root);
      if (row) row.push(b);
      else rows.set(root, [b]);
    }
    const snap = (v: number) => Math.round(v / PIXEL_TILE) * PIXEL_TILE;
    for (const members of rows.values()) {
      if (members.length < 2) continue;
      const x0 = Math.min(...members.map((b) => b.x));
      const y0 = Math.min(...members.map((b) => b.y));
      const x1 = Math.max(...members.map((b) => b.x + b.w));
      const y1 = Math.max(...members.map((b) => b.y + b.h));
      const acrossRow = x1 - x0 >= y1 - y0;
      const length = acrossRow ? x1 - x0 : y1 - y0;
      const pieces = Math.max(1, Math.round(length / ((acrossRow ? 5 : 7) * PIXEL_TILE)));
      const unused = [...members].sort((a, b) => (acrossRow ? a.x - b.x : a.y - b.y));
      const merged: PixelBuilding[] = [];
      for (let k = 0; k < pieces; k++) {
        const from = snap((acrossRow ? x0 : y0) + (length * k) / pieces);
        const to = snap((acrossRow ? x0 : y0) + (length * (k + 1)) / pieces);
        const rect = acrossRow ? { x: from, y: snap(y0), w: to - from, h: snap(y1) - snap(y0) } : { x: snap(x0), y: from, w: snap(x1) - snap(x0), h: to - from };
        if (rect.w < 2 * PIXEL_TILE || rect.h < 2 * PIXEL_TILE) continue;
        // Keep the id (and so any later hand edit) of a house that stood in this piece. A row cut
        // into more pieces than it had houses gets made-up ids far above any OpenStreetMap id.
        const owner = unused.shift() ?? { id: 1e15 + members[0]!.id * 100 + k };
        const type = rect.w >= 52 ? "B" : "A";
        const options = Object.keys(this.variants).filter((v) => v[0] === type && this.variants[v]!.min_w <= rect.w);
        const pool = options.length > 0 ? options : Object.keys(this.variants).filter((v) => v[0] === "A");
        const look = pool[pixelHash(owner.id) % pool.length]!;
        merged.push({ id: owner.id, ...rect, look, name: null, sprite: null });
      }
      const gone = new Set(members);
      this.buildings = [...this.buildings.filter((b) => !gone.has(b)), ...merged];
    }
  }

  /** Re-sorts buildings back to front and rebuilds which chunks each one touches. */
  private reindex(): void {
    // Back to front: buildings lower on screen are nearer and draw last.
    this.buildings.sort((a, b) => a.y + a.h - (b.y + b.h));
    this.chunkBuildings.clear();
    for (const b of this.buildings) {
      // +8 px: the shadow reaches past the bottom-right edge.
      for (let cy = Math.floor(b.y / PIXEL_CHUNK); cy <= Math.floor((b.y + b.h + 8) / PIXEL_CHUNK); cy++) {
        for (let cx = Math.floor(b.x / PIXEL_CHUNK); cx <= Math.floor((b.x + b.w + 8) / PIXEL_CHUNK); cx++) {
          const key = cy * 10000 + cx;
          const list = this.chunkBuildings.get(key);
          if (list) list.push(b);
          else this.chunkBuildings.set(key, [b]);
        }
      }
    }
  }

  private sprite(b: PixelBuilding): HTMLCanvasElement {
    if (b.sprite) return b.sprite;
    const variant = this.variants[b.look];
    const pixels = variant
      ? stretchBuilding(this.buildingSheet!, variant, b.w, b.h, pixelHash(b.id))
      : roofAndWall(this.roofSheets[PIXEL_ROOF_BY_BUILDING[b.name ?? ""] ?? pixelHash(b.id) % this.roofSheets.length]!, this.wallSheet!, b.w, b.h, pixelHash(b.id + 7));
    const [canvas, ctx] = pixelCanvas(pixels.width, pixels.height);
    ctx.putImageData(pixels, 0, 0);
    const topper = b.name ? this.toppers.get(b.name) : undefined;
    if (topper) {
      const r = topperRect(b, topper.img, topper.scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(topper.img, r.x, r.y, r.w, r.h);
    }
    b.sprite = canvas;
    return canvas;
  }

  // -------------------------------------------------------------------------
  // Chunks

  private renderChunk(cx: number, cy: number, level: number): HTMLCanvasElement {
    const size = PIXEL_CHUNK >> level;
    const b = PIXEL_TILE >> level;
    const [canvas, ctx] = pixelCanvas(size, size);
    const img = ctx.createImageData(size, size);
    for (let ty = 0; ty < PIXEL_CHUNK_TILES; ty++) {
      const gy = cy * PIXEL_CHUNK_TILES + ty;
      if (gy >= this.rows) break;
      for (let tx = 0; tx < PIXEL_CHUNK_TILES; tx++) {
        const gx = cx * PIXEL_CHUNK_TILES + tx;
        if (gx >= this.cols) break;
        const t = gy * this.cols + gx;
        const block = this.darkGrass[t] ? this.darkGrassBlocks[level] : this.tileBlocks[this.tileIds[t]!]?.[level];
        if (!block) continue;
        for (let y = 0; y < b; y++) img.data.set(block.subarray(y * b * 4, (y + 1) * b * 4), ((ty * b + y) * size + tx * b) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = level > 0;
    const f = 1 << level;
    const ox = cx * PIXEL_CHUNK;
    const oy = cy * PIXEL_CHUNK;
    const key = cy * 10000 + cx;
    const buildings = this.chunkBuildings.get(key) ?? [];
    const props = this.chunkProps.get(key) ?? [];
    // Shadows first, down and to the right (the light comes from the top-left).
    ctx.fillStyle = "rgba(46, 34, 47, 0.3)";
    for (const b of buildings) {
      ctx.fillRect((b.x - ox + 6) / f, (b.y - oy + 6) / f, b.w / f, b.h / f);
    }
    for (const p of props) {
      if (p.kind === "tree" || p.kind === "bush") {
        const r = p.kind === "tree" ? 11 : 6;
        ctx.beginPath();
        ctx.ellipse((p.x - ox + p.w / 2 + 3) / f, (p.y - oy + p.h - 2) / f, r / f, (r / 3) / f, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Fences: the piece follows the neighbours (across, up-down, or a lone post).
    const fenceItems: { fence: number; x: number; y: number; w: number; h: number }[] = [];
    if (this.fences.size > 0) {
      const has = (x: number, y: number) => x >= 0 && y >= 0 && x < this.cols && y < this.rows && this.fences.has(y * this.cols + x);
      for (let ty = cy * PIXEL_CHUNK_TILES; ty < (cy + 1) * PIXEL_CHUNK_TILES; ty++) {
        for (let tx = cx * PIXEL_CHUNK_TILES; tx < (cx + 1) * PIXEL_CHUNK_TILES; tx++) {
          if (!has(tx, ty)) continue;
          const piece = has(tx - 1, ty) || has(tx + 1, ty) ? 0 : has(tx, ty - 1) || has(tx, ty + 1) ? 1 : 2;
          fenceItems.push({ fence: piece, x: tx * PIXEL_TILE, y: ty * PIXEL_TILE, w: PIXEL_TILE, h: PIXEL_TILE });
        }
      }
    }
    const items: (PixelBuilding | PixelProp | (typeof fenceItems)[number])[] = [...buildings, ...props, ...fenceItems];
    items.sort((a, b) => a.y + a.h - (b.y + b.h));
    for (const it of items) {
      if ("fence" in it) {
        if (this.fenceImage) ctx.drawImage(this.fenceImage, it.fence * PIXEL_TILE, 0, PIXEL_TILE, PIXEL_TILE, (it.x - ox) / f, (it.y - oy) / f, it.w / f, it.h / f);
      } else if ("kind" in it) {
        const r = this.propRects[it.kind];
        if (r && this.propImage) ctx.drawImage(this.propImage, r.x, r.y, r.w, r.h, (it.x - ox) / f, (it.y - oy) / f, it.w / f, it.h / f);
      } else {
        ctx.drawImage(this.sprite(it), (it.x - ox) / f, (it.y - oy) / f, it.w / f, it.h / f);
      }
    }
    return canvas;
  }

  /**
   * The whole world at one pixel per tile (the smallest mip level), with buildings: a blocky
   * stand-in for chunks that aren't drawn yet, so the street map never shows through.
   */
  private renderOverview(): HTMLCanvasElement {
    const [canvas, ctx] = pixelCanvas(this.cols, this.rows);
    const img = ctx.createImageData(this.cols, this.rows);
    for (let i = 0; i < this.cols * this.rows; i++) {
      const block = this.darkGrass[i] ? this.darkGrassBlocks[PIXEL_MAX_LEVEL] : this.tileBlocks[this.tileIds[i]!]?.[PIXEL_MAX_LEVEL];
      if (block) img.data.set(block.subarray(0, 4), i * 4);
    }
    ctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    for (const b of this.buildings) ctx.drawImage(this.sprite(b), b.x / PIXEL_TILE, b.y / PIXEL_TILE, b.w / PIXEL_TILE, b.h / PIXEL_TILE);
    return canvas;
  }

  /** A cached chunk, drawing it now if there's time left this frame. */
  private chunk(cx: number, cy: number, level: number, mayRender: boolean): HTMLCanvasElement | null {
    const key = `${level}:${cx}:${cy}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key); // most recently used goes last
      this.chunks.set(key, hit);
      return hit;
    }
    if (!mayRender) return null;
    const canvas = this.renderChunk(cx, cy, level);
    this.chunks.set(key, canvas);
    this.cacheBytes += canvas.width * canvas.height * 4;
    for (const [k, c] of this.chunks) {
      if (this.cacheBytes <= PIXEL_CACHE_BYTES) break;
      this.chunks.delete(k);
      this.cacheBytes -= c.width * c.height * 4;
    }
    return canvas;
  }

  // -------------------------------------------------------------------------
  // Drawing

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  /** Follows Leaflet's zoom animation by scaling the current picture the same way. */
  private onZoomAnim(e: L.ZoomAnimEvent): void {
    if (!this.baseTransform) return;
    this.animating = true;
    const k = this.map.getZoomScale(e.zoom, this.map.getZoom());
    const q = this.map.latLngToContainerPoint(e.center);
    const size = this.map.getSize();
    this.canvas.style.transform = `${this.baseTransform} translate(${size.x / 2 - k * q.x}px, ${size.y / 2 - k * q.y}px) scale(${k})`;
  }

  private draw(): void {
    if (this.animating) return;
    const map = this.map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(size.x * dpr);
    const ch = Math.round(size.y * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.canvas.style.width = `${size.x}px`;
      this.canvas.style.height = `${size.y}px`;
    }
    // Put the canvas's top-left on the map's top-left, turned back so it's square to the screen.
    const p0 = map.containerPointToLayerPoint([0, 0]);
    this.baseTransform = `translate3d(${p0.x}px, ${p0.y}px, 0) rotate(${-this.opts.bearing}deg)`;
    this.canvas.style.transform = `${this.baseTransform} translate(0px, 0px) scale(1)`;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const zoom = map.getZoom();
    if (!this.ready || zoom < PIXEL_MIN_ZOOM) return;

    // Art grid -> device pixels: x' = (x - refGrid) * s + refScreen.
    const s = 2 ** (zoom - PIXEL_ZOOM) * dpr;
    const ref = map.getCenter();
    const [rgx, rgy] = this.toGrid(ref.lat, ref.lng);
    const rc = map.latLngToContainerPoint(ref);
    const rsx = rc.x * dpr - (rgx - this.ox) * s;
    const rsy = rc.y * dpr - (rgy - this.oy) * s;
    // Coarsest mip level that still only ever scales up on screen.
    const level = Math.max(0, Math.min(PIXEL_MAX_LEVEL, Math.ceil(Math.log2(1 / s) - 1e-9)));

    const outline = () => {
      ctx.beginPath();
      for (const ring of this.opts.rings) {
        ring.forEach(([lat, lng], i) => {
          const p = map.latLngToContainerPoint([lat, lng]);
          if (i === 0) ctx.moveTo(p.x * dpr, p.y * dpr);
          else ctx.lineTo(p.x * dpr, p.y * dpr);
        });
        ctx.closePath();
      }
    };
    ctx.save();
    outline();
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    const cx0 = Math.max(0, Math.floor(-rsx / s / PIXEL_CHUNK));
    const cy0 = Math.max(0, Math.floor(-rsy / s / PIXEL_CHUNK));
    const cx1 = Math.min(this.chunkCols - 1, Math.floor((cw - rsx) / s / PIXEL_CHUNK));
    const cy1 = Math.min(this.chunkRows - 1, Math.floor((ch - rsy) / s / PIXEL_CHUNK));
    const started = performance.now();
    let missing = false;
    // Centre chunks first, so the middle of the view fills in first.
    const order: [number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) order.push([cx, cy]);
    const mx = (cx0 + cx1) / 2;
    const my = (cy0 + cy1) / 2;
    order.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
    for (const [cx, cy] of order) {
      let canvas = this.chunk(cx, cy, level, performance.now() - started < PIXEL_FRAME_BUDGET);
      if (!canvas) {
        missing = true;
        // Meanwhile, show the same chunk at a neighbouring size if it's cached.
        canvas =
          this.chunk(cx, cy, Math.min(PIXEL_MAX_LEVEL, level + 1), false) ??
          this.chunk(cx, cy, Math.max(0, level - 1), false) ??
          null;
        if (!canvas) {
          // Not drawn at any size yet: the overview's blocky version until it is.
          if (this.overview) {
            const x0 = Math.round(rsx + cx * PIXEL_CHUNK * s);
            const y0 = Math.round(rsy + cy * PIXEL_CHUNK * s);
            const x1 = Math.round(rsx + (cx + 1) * PIXEL_CHUNK * s);
            const y1 = Math.round(rsy + (cy + 1) * PIXEL_CHUNK * s);
            const t = PIXEL_CHUNK_TILES;
            ctx.drawImage(this.overview, cx * t, cy * t, t, t, x0, y0, x1 - x0, y1 - y0);
          }
          continue;
        }
      }
      const x0 = Math.round(rsx + cx * PIXEL_CHUNK * s);
      const y0 = Math.round(rsy + cy * PIXEL_CHUNK * s);
      const x1 = Math.round(rsx + (cx + 1) * PIXEL_CHUNK * s);
      const y1 = Math.round(rsy + (cy + 1) * PIXEL_CHUNK * s);
      ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0);
    }
    this.drawLabels(ctx, rsx, rsy, s, dpr, zoom, cw, ch);
    ctx.restore();

    // A thin edge where the pixel world meets the street map.
    outline();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = "rgba(46, 34, 47, 0.7)";
    ctx.stroke();

    if (missing) this.queueDraw();
  }
}
