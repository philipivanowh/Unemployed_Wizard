// Map page: upcoming events as pins on an OpenStreetMap map, limited to downtown
// Montreal (McGill Area). Townspeople walk the real walkways on a daily routine,
// crowds gather at events while they're on, and "Take me there" draws a walking route.
// index.html loads Leaflet (global `L`), leaflet-rotate, npc.ts, walk-graph.ts, routine.ts,
// crowds.ts, route-guide.ts, area-data.ts and area.ts before this file.

interface MapEvent {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string | null;
  address: string;
  roomNumber: string | null;
  freeItems: string[];
  description: string;
  thumbnailUrl: string | null;
  latitude: number | null;
  longitude: number | null;
}

// ---------------------------------------------------------------------------
// Map, locked to the downtown area

/**
 * Map rotation in degrees, clockwise: 0 keeps north up, 90 turns the map a quarter
 * turn clockwise, -30 tilts it 30° the other way. Pins, popups and the NPC stay upright.
 * Uses the leaflet-rotate add-on (GPL-3.0).
 */
const MAP_ROTATION = 55;

const areaRings = DOWNTOWN_AREAS.map((area) => area.ring);
const areaBounds = L.latLngBounds(areaRings.flat());

const eventMap = L.map("map", {
  maxBoundsViscosity: 1, // can't drag past the edge
  zoomSnap: 0.25,
  // Fixed rotation: no rotate button, and no Shift+wheel, right-drag or touch gestures to change it.
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: false,
  pitchDrag: false,
  touchRotate: false,
});
// Order matters: leaflet-rotate crashes if the bearing or the max bounds are set
// before the map has a view. Show the area, rotate, then fit again for the rotated view.
eventMap.fitBounds(areaBounds);
eventMap.setBearing(MAP_ROTATION);
eventMap.fitBounds(areaBounds);
eventMap.setMaxBounds(areaBounds.pad(0.05));

/** True while a walking route is shown (the map may then go past its area). */
let routeShown = false;

/** You can't zoom out further than the whole area (except while a walking route is shown). */
function fitMinZoomToArea(): void {
  if (routeShown) return;
  eventMap.setMinZoom(eventMap.getBoundsZoom(areaBounds));
}
fitMinZoomToArea();
eventMap.on("resize", fitMinZoomToArea);

// OpenStreetMap's tile servers require this attribution and are meant for light use.
// `bounds` stops tiles far outside the area from being requested; the margin is wide
// enough to fill the corners when the map is rotated.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  bounds: areaBounds.pad(0.5),
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(eventMap);

// Dim everything outside the area: a world-sized polygon with the area cut out.
const worldRing: [number, number][] = [
  [90, -180],
  [90, 180],
  [-90, 180],
  [-90, -180],
];
L.polygon([worldRing, ...areaRings], {
  stroke: false,
  fillColor: "#111827",
  fillOpacity: 0.35,
  interactive: false,
}).addTo(eventMap);
for (const ring of areaRings) {
  L.polygon(ring, { color: "#2563eb", weight: 2, fill: false, interactive: false }).addTo(eventMap);
}

// ---------------------------------------------------------------------------
// Event pins

/** How often to check for new events and update which ones are live. */
const EVENT_REFRESH_MS = 60_000;
const LIVE_CHECK_MS = 15_000;

type LocatedEvent = MapEvent & { latitude: number; longitude: number };

function localDateIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const formatClock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function formatWhen(event: MapEvent): string {
  const day = new Date(`${event.date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = (hhmm: string) => formatClock(new Date(`${event.date}T${hhmm}:00`));
  return `${day} · ${time(event.startTime)}${event.endTime ? `–${time(event.endTime)}` : ""}`;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text; // textContent, so event text can't inject HTML
  if (className) element.className = className;
  return element;
}

/** "Happening now · until 7:00 PM" or "Starts in 12 min", if it applies. */
function liveBadge(event: LocatedEvent): HTMLElement | null {
  const now = gameClock.now;
  const phase = eventPhase(event, now);
  const { start, end } = eventWindow(event);
  if (phase === "live") return makeElement("div", `Happening now · until ${formatClock(end)}`, "live-badge");
  if (phase === "soon") {
    const minutes = Math.max(1, Math.round((start.getTime() - now.getTime()) / 60_000));
    return makeElement("div", `Starts in ${minutes} min`, "live-badge soon");
  }
  return null;
}

function eventPopup(event: LocatedEvent): HTMLElement {
  const popup = makeElement("div", undefined, "event-popup");
  if (event.thumbnailUrl) {
    const img = makeElement("img");
    img.src = event.thumbnailUrl;
    img.alt = "";
    popup.append(img);
  }
  const badge = liveBadge(event);
  if (badge) popup.append(badge);
  popup.append(makeElement("h3", event.title));
  popup.append(makeElement("p", formatWhen(event)));
  popup.append(
    makeElement("p", event.roomNumber ? `${event.address}, room ${event.roomNumber}` : event.address, "muted"),
  );
  if (event.freeItems.length > 0) popup.append(makeElement("p", `Free: ${event.freeItems.join(", ")}`, "free"));
  if (event.description) {
    const text = event.description.length > 160 ? `${event.description.slice(0, 157)}…` : event.description;
    popup.append(makeElement("p", text));
  }
  const go = makeElement("button", "Take me there", "take-me-there");
  go.type = "button";
  go.addEventListener("click", () => {
    eventMap.closePopup();
    void routeGuide.start(event);
  });
  popup.append(go);
  return popup;
}

/** Events with a location inside the area, by id. Townspeople and crowds use these too. */
const eventsById = new Map<string, LocatedEvent>();
const pinsById = new Map<string, L.Marker>();
const liveRingsById = new Map<string, L.Marker>();
let downtownEvents: LocatedEvent[] = [];
let eventSummary = "";

// Pulsing rings for live events sit just under the pins.
const liveRingPane = eventMap.createPane("liveRings", eventMap.getPane("norotatePane"));
liveRingPane.style.zIndex = "590";
liveRingPane.style.pointerEvents = "none";

async function refreshEvents(): Promise<void> {
  const status = document.getElementById("map-status");
  try {
    const res = await fetch(`/api/events?from=${localDateIso(new Date())}&limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { events: MapEvent[]; total: number };

    const located = data.events.flatMap((event): LocatedEvent[] =>
      event.latitude !== null && event.longitude !== null
        ? [{ ...event, latitude: event.latitude, longitude: event.longitude }]
        : [],
    );
    downtownEvents = located.filter((event) => isInDowntown(event.latitude, event.longitude));

    // Add new pins, move edited ones, remove deleted ones.
    const seen = new Set<string>();
    for (const event of downtownEvents) {
      seen.add(event.id);
      eventsById.set(event.id, event);
      const existing = pinsById.get(event.id);
      if (existing) {
        existing.setLatLng([event.latitude, event.longitude]);
        continue;
      }
      const marker = L.marker([event.latitude, event.longitude], { title: event.title })
        // Built when opened, so the live badge is always current.
        .bindPopup(() => eventPopup(eventsById.get(event.id) ?? event))
        .addTo(eventMap);
      pinsById.set(event.id, marker);
    }
    for (const [id, marker] of pinsById) {
      if (seen.has(id)) continue;
      marker.remove();
      pinsById.delete(id);
      eventsById.delete(id);
    }

    const outside = located.length - downtownEvents.length;
    const missing = data.events.length - located.length;
    const notes = [outside > 0 ? `${outside} outside downtown` : "", missing > 0 ? `${missing} without a location` : ""].filter(Boolean);
    eventSummary =
      data.events.length === 0
        ? "No upcoming events yet"
        : `${downtownEvents.length} upcoming event${downtownEvents.length === 1 ? "" : "s"} downtown` +
          (notes.length ? ` · ${notes.join(" · ")}` : "");
    updateLive();
  } catch (err) {
    console.error("Failed to load events", err);
    if (status && !eventSummary) status.textContent = "Couldn't load events";
  }
}

/** Marks live events, keeps crowds in sync, and updates the header. */
function updateLive(): void {
  gameClock.update();
  const now = gameClock.now;
  let liveCount = 0;
  for (const event of downtownEvents) {
    const phase = eventPhase(event, now);
    const live = phase === "live";
    if (live) liveCount++;
    const ring = liveRingsById.get(event.id);
    if ((live || phase === "soon") && !ring) {
      const icon = L.divIcon({ className: `live-ring${live ? "" : " soon"}`, html: "<span></span>", iconSize: [56, 56], iconAnchor: [28, 28] });
      liveRingsById.set(event.id, L.marker([event.latitude, event.longitude], { icon, pane: "liveRings", interactive: false, keyboard: false }).addTo(eventMap));
    } else if (ring && !live && phase !== "soon") {
      ring.remove();
      liveRingsById.delete(event.id);
    } else if (ring) {
      ring.getElement()?.classList.toggle("soon", !live);
    }
  }
  for (const [id, ring] of liveRingsById) {
    if (!eventsById.has(id)) {
      ring.remove();
      liveRingsById.delete(id);
    }
  }
  crowds?.sync(downtownEvents, now, false);

  const status = document.getElementById("map-status");
  if (status) status.textContent = eventSummary + (liveCount > 0 ? ` · ${liveCount} happening now` : "");
}

// ---------------------------------------------------------------------------
// People on the map
//
// Residents (routine.ts), event crowds (crowds.ts) and the route guide all walk the area's
// real paths (OpenStreetMap, via /api/walkways). Positions are map pixel coordinates at
// NPC_MAP_ZOOM. Each person is drawn into a small canvas inside a Leaflet marker, so Leaflet
// keeps them on the map while panning and zooming, and stacks nearer people in front.

/** How many residents walk around (crowds and the guide come on top). */
const NPC_COUNT = 14;
const NPC_MAP_ZOOM = 16;

// Own pane: above the live rings (590) but below the event pins (600), so people never
// cover a pin. It sits beside the pins in leaflet-rotate's "norotatePane" so people
// stay upright on a rotated map. People are scenery: nothing on them reacts to the
// mouse, so clicks and hovers go straight through to the pins and the map.
const npcPane = eventMap.createPane("npc", eventMap.getPane("norotatePane"));
npcPane.style.zIndex = "595";
npcPane.style.pointerEvents = "none";

// While Leaflet animates a zoom (about 250 ms) it moves the markers itself; moving them
// then would make them jump. The time limit means a missed zoomend can never freeze them.
let zoomAnimationUntil = 0;
eventMap.on("zoomanim", () => (zoomAnimationUntil = performance.now() + 400));
eventMap.on("zoomend", () => (zoomAnimationUntil = 0));

const gameClock = new GameClock();
const gameClockEl = document.getElementById("game-clock");

interface WalkerView {
  walker: Walker;
  marker: L.Marker;
  ctx: CanvasRenderingContext2D;
  lastFrame: string;
}
const walkers: WalkerView[] = [];

const npcCanvasSize = { x: NPC_CELL_W * NPC_SIZE, y: NPC_CELL_H * NPC_SIZE };
const npcAnchor = { x: NPC_FEET_X * NPC_SIZE, y: NPC_FEET_Y * NPC_SIZE };
const npcDpr = window.devicePixelRatio || 1;

const toMapPoint = (lat: number, lng: number): WalkPoint => {
  const p = eventMap.project([lat, lng], NPC_MAP_ZOOM);
  return { x: p.x, y: p.y };
};
const toLatLng = (p: WalkPoint) => eventMap.unproject([p.x, p.y], NPC_MAP_ZOOM);

/** A new person, facing by how their walk looks on the rotated map. */
function makeNpc(appearance?: NpcAppearance): Npc {
  const npc = new Npc({ appearance });
  npc.viewRotation = (MAP_ROTATION * Math.PI) / 180;
  return npc;
}

let walkGraph: WalkGraph | null = null;
let crowds: CrowdManager | null = null;

async function loadWalkGraph(): Promise<WalkGraph | null> {
  const b = areaBounds.pad(0.02);
  const params = new URLSearchParams({
    south: b.getSouth().toFixed(4),
    west: b.getWest().toFixed(4),
    north: b.getNorth().toFixed(4),
    east: b.getEast().toFixed(4),
  });
  try {
    const res = await fetch(`/api/walkways?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return WalkGraph.fromData((await res.json()) as WalkwayGraphData, toMapPoint, isInDowntown);
  } catch (err) {
    console.warn("Couldn't load walkways; people will walk in straight lines.", err);
    return null;
  }
}

/** Without walkway data: straight lines between the named spots (or points in the area). */
function fallbackGraph(): WalkGraph {
  const spots = DOWNTOWN_SPOTS.filter((s) => isInDowntown(s.lat, s.lng)).map((s) => toMapPoint(s.lat, s.lng));
  const points = spots.length >= 2 ? spots : areaRings.flat().map(([lat, lng]) => toMapPoint(lat, lng));
  return WalkGraph.fromPoints(points);
}

/** Where residents spend their day: the named spots, upcoming events, and a few street corners. */
function routinePlaces(graph: WalkGraph): RoutinePlace[] {
  const at = (lat: number, lng: number) => {
    const p = toMapPoint(lat, lng);
    return graph.nearest(p.x, p.y);
  };
  const places: RoutinePlace[] = [
    ...DOWNTOWN_SPOTS.filter((s) => isInDowntown(s.lat, s.lng)).map((s) => ({ name: s.name, node: at(s.lat, s.lng) })),
    ...downtownEvents.map((e) => ({ name: e.title, node: at(e.latitude, e.longitude) })),
  ];
  const corners = ["a street corner", "a quiet block", "a shady spot", "a bench", "the crosswalk", "a friend's place"];
  for (const name of corners) {
    if (places.length >= 10) break;
    places.push({ name, node: graph.randomNode() });
  }
  return places;
}

/** Puts anyone who walks on the map. */
function addWalker(walker: Walker): void {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(npcCanvasSize.x * npcDpr);
  canvas.height = Math.round(npcCanvasSize.y * npcDpr);
  canvas.style.width = `${npcCanvasSize.x}px`;
  canvas.style.height = `${npcCanvasSize.y}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const marker = L.marker(toLatLng(walker.npc), {
    icon: L.divIcon({
      html: canvas,
      className: "npc-marker",
      iconSize: [npcCanvasSize.x, npcCanvasSize.y],
      iconAnchor: [npcAnchor.x, npcAnchor.y],
    }),
    pane: "npc",
    interactive: false, // no clicks, hovers or cursor change
    keyboard: false,
  }).addTo(eventMap);
  walkers.push({ walker, marker, ctx, lastFrame: "" });
}

async function startPeople(): Promise<void> {
  const [graph] = await Promise.all([loadWalkGraph(), eventsLoaded]);
  walkGraph = graph;
  const network = graph ?? fallbackGraph();
  const places = routinePlaces(network);
  for (let i = 0; i < NPC_COUNT; i++) {
    const resident = new Resident(makeNpc(), network, places);
    resident.placeAt(gameClock);
    addWalker(resident);
  }
  crowds = new CrowdManager(network, toMapPoint, () => makeNpc(), addWalker);
  crowds.sync(downtownEvents, gameClock.now, true);
  updateLive();
  requestAnimationFrame(frame);
}

let lastFrameTime = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  gameClock.update();
  if (gameClockEl && gameClockEl.textContent !== gameClock.label) gameClockEl.textContent = gameClock.label;

  const worldScale = Math.pow(2, eventMap.getZoom() - NPC_MAP_ZOOM);
  const settled = now > zoomAnimationUntil;
  for (let i = walkers.length - 1; i >= 0; i--) {
    const view = walkers[i]!;
    const { walker, marker, ctx } = view;
    const npc = walker.npc;
    npc.worldScale = worldScale;
    walker.update(dt, gameClock);
    if (walker.done) {
      marker.remove();
      walkers.splice(i, 1);
      continue;
    }
    if (settled) marker.setLatLng(toLatLng(npc));

    const key = npc.frameKey;
    if (key !== view.lastFrame) {
      view.lastFrame = key;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.setTransform(npcDpr, 0, 0, npcDpr, 0, 0);
      npc.draw(ctx, npcAnchor);
      // People at home are hidden.
      const el = marker.getElement();
      if (el) el.style.visibility = npc.opacity > 0 ? "visible" : "hidden";
    }
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// "Take me there"

let guideWalker: RouteGuideWalker | null = null;

const routeGuide = new RouteGuide({
  map: eventMap,
  graph: () => walkGraph,
  toPoint: toMapPoint,
  toLatLng,
  // Let the map show where you are, even outside the area, while a route is up.
  onActiveChange: (active) => {
    routeShown = active;
    if (active) {
      eventMap.setMaxBounds(null as unknown as L.LatLngBounds);
      eventMap.setMinZoom(3);
    } else {
      eventMap.setMaxBounds(areaBounds.pad(0.05));
      fitMinZoomToArea();
    }
  },
  onGuide: (points, target) => {
    guideWalker?.dismiss();
    guideWalker = null;
    if (!points || !target) return;
    // A guide in a bright cap and orange shirt, easy to follow.
    const look = randomNpcAppearance();
    look.hat = { style: "cap", color: "#e8c547" };
    look.top = { style: "tshirt", color: "#e8833a", accent: look.top.accent };
    guideWalker = new RouteGuideWalker(makeNpc(look), points, target.title);
    addWalker(guideWalker);
  },
});

const eventsLoaded = refreshEvents().then(() => {
  // /?event=<id> (the Add Event page links here) opens that event's pin.
  const focusId = new URLSearchParams(location.search).get("event");
  const event = focusId ? eventsById.get(focusId) : undefined;
  if (event) {
    eventMap.setView([event.latitude, event.longitude], Math.max(eventMap.getZoom(), 17), { animate: false });
    pinsById.get(event.id)?.openPopup();
  }
});
setInterval(() => void refreshEvents(), EVENT_REFRESH_MS);
setInterval(updateLive, LIVE_CHECK_MS);

void startPeople();
