// Map page: upcoming events as pins on an OpenStreetMap map, limited to downtown
// Montreal (Ville-Marie + Milton-Parc), with the sign-holding NPC roaming around.
// map.html loads Leaflet (global `L`), npc.ts and area.ts before this file.

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

const areaRings = DOWNTOWN_AREAS.map((area) => area.ring);
const areaBounds = L.latLngBounds(areaRings.flat());

const eventMap = L.map("map", {
  maxBounds: areaBounds.pad(0.05),
  maxBoundsViscosity: 1, // can't drag past the edge
  zoomSnap: 0.25,
});
eventMap.fitBounds(areaBounds);

/** You can't zoom out further than the whole area. */
function fitMinZoomToArea(): void {
  eventMap.setMinZoom(eventMap.getBoundsZoom(areaBounds));
}
fitMinZoomToArea();
eventMap.on("resize", fitMinZoomToArea);

// OpenStreetMap's tile servers require this attribution and are meant for light use.
// `bounds` stops tiles outside the area from being requested.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  bounds: areaBounds.pad(0.1),
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

function localDateIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatWhen(event: MapEvent): string {
  const day = new Date(`${event.date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = (hhmm: string) =>
    new Date(`${event.date}T${hhmm}:00`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

function eventPopup(event: MapEvent): HTMLElement {
  const popup = makeElement("div", undefined, "event-popup");
  if (event.thumbnailUrl) {
    const img = makeElement("img");
    img.src = event.thumbnailUrl;
    img.alt = "";
    popup.append(img);
  }
  popup.append(makeElement("h3", event.title));
  popup.append(makeElement("p", formatWhen(event)));
  popup.append(
    makeElement("p", event.roomNumber ? `${event.address}, room ${event.roomNumber}` : event.address, "muted"),
  );
  popup.append(makeElement("p", `Free: ${event.freeItems.join(", ")}`, "free"));
  if (event.description) {
    const text = event.description.length > 160 ? `${event.description.slice(0, 157)}…` : event.description;
    popup.append(makeElement("p", text));
  }
  return popup;
}

/** Events with a location inside the area; the NPC visits these too. */
let downtownEvents: (MapEvent & { latitude: number; longitude: number })[] = [];

async function loadEventPins(): Promise<void> {
  const status = document.getElementById("map-status");
  try {
    const res = await fetch(`/api/events?from=${localDateIso(new Date())}&limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { events: MapEvent[]; total: number };

    const located = data.events.flatMap((event) =>
      event.latitude !== null && event.longitude !== null
        ? [{ ...event, latitude: event.latitude, longitude: event.longitude }]
        : [],
    );
    downtownEvents = located.filter((event) => isInDowntown(event.latitude, event.longitude));
    for (const event of downtownEvents) {
      L.marker([event.latitude, event.longitude], { title: event.title })
        .bindPopup(eventPopup(event))
        .addTo(eventMap);
    }

    const outside = located.length - downtownEvents.length;
    const missing = data.events.length - located.length;
    if (status) {
      const notes = [
        outside > 0 ? `${outside} outside downtown` : "",
        missing > 0 ? `${missing} without a location` : "",
      ].filter(Boolean);
      status.textContent =
        data.events.length === 0
          ? "No upcoming events yet"
          : `${downtownEvents.length} upcoming event${downtownEvents.length === 1 ? "" : "s"} downtown` +
            (notes.length ? ` · ${notes.join(" · ")}` : "");
    }
  } catch (err) {
    console.error("Failed to load events", err);
    if (status) status.textContent = "Couldn't load events";
  }
}

void loadEventPins();

// ---------------------------------------------------------------------------
// Roaming NPC
//
// The NPC's x/y are map pixel coordinates at NPC_MAP_ZOOM, so it stays put on the
// map while you pan and zoom. Each frame they're converted to screen position.

const NPC_MAP_ZOOM = 16;
const NPC_SCREEN_SPEED = 40; // screen pixels per second

const roamer = new Npc({ x: 0, y: 0, pixelSize: 2, headRadius: 14, speed: NPC_SCREEN_SPEED });
const roamerStart = eventMap.project([DOWNTOWN_SPOTS[0]!.lat, DOWNTOWN_SPOTS[0]!.lng], NPC_MAP_ZOOM);
roamer.x = roamerStart.x;
roamer.y = roamerStart.y;

const npcLayer = document.createElement("canvas");
npcLayer.className = "npc-layer";
eventMap.getContainer().append(npcLayer);
const npcLayerCtx = npcLayer.getContext("2d");

function sizeNpcLayer(): void {
  const size = eventMap.getSize();
  const dpr = window.devicePixelRatio || 1;
  npcLayer.width = Math.round(size.x * dpr);
  npcLayer.height = Math.round(size.y * dpr);
  npcLayer.style.width = `${size.x}px`;
  npcLayer.style.height = `${size.y}px`;
}
sizeNpcLayer();
eventMap.on("resize", sizeNpcLayer);

// Leaflet animates zooms with CSS, so hide the NPC until the zoom settles.
let mapZooming = false;
eventMap.on("zoomstart", () => (mapZooming = true));
eventMap.on("zoomend", () => (mapZooming = false));

/** Seconds to stand idle before roaming again. Infinity while a walk is under way. */
let roamPause = 1.5;

/**
 * Walk the NPC to a map location, holding `sign`, then stand there for `pauseSeconds`.
 * Clicking the map or calling this again interrupts the current walk.
 */
function walkNpcTo(lat: number, lng: number, sign = "FREE FOOD", pauseSeconds = 3): Promise<boolean> {
  const point = eventMap.project([lat, lng], NPC_MAP_ZOOM);
  roamer.setSignText(sign);
  roamPause = Infinity;
  return roamer.walkTo(point.x, point.y).then((arrived) => {
    if (arrived) roamPause = pauseSeconds;
    return arrived;
  });
}

function signFor(event: MapEvent): string {
  const item = event.freeItems[0]?.toUpperCase() ?? "";
  return item && item.length <= 10 ? `FREE ${item}` : "FREE FOOD";
}

/** Half the time head to an event and advertise it, otherwise wander. */
function roamSomewhere(): void {
  const event = downtownEvents[Math.floor(Math.random() * downtownEvents.length)];
  if (event && Math.random() < 0.5) {
    void walkNpcTo(event.latitude, event.longitude, signFor(event), 6 + Math.random() * 4);
  } else {
    const [lat, lng] = randomDowntownPoint();
    void walkNpcTo(lat, lng, "FREE FOOD", 2 + Math.random() * 3);
  }
}

// Click anywhere in the area to send the NPC there.
eventMap.on("click", (e: L.LeafletMouseEvent) => {
  if (isInDowntown(e.latlng.lat, e.latlng.lng)) void walkNpcTo(e.latlng.lat, e.latlng.lng, "FREE FOOD", 4);
});

let lastNpcFrame = performance.now();

function npcFrame(now: number): void {
  const dt = Math.min(0.05, (now - lastNpcFrame) / 1000);
  lastNpcFrame = now;

  if (roamer.state === "idleWithSign" && roamPause !== Infinity) {
    roamPause -= dt;
    if (roamPause <= 0) roamSomewhere();
  }

  roamer.worldScale = Math.pow(2, eventMap.getZoom() - NPC_MAP_ZOOM);
  roamer.update(dt);

  if (npcLayerCtx) {
    const dpr = window.devicePixelRatio || 1;
    npcLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    npcLayerCtx.clearRect(0, 0, npcLayer.width, npcLayer.height);
    if (!mapZooming) {
      npcLayerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const where = eventMap.latLngToContainerPoint(eventMap.unproject([roamer.x, roamer.y], NPC_MAP_ZOOM));
      roamer.draw(npcLayerCtx, where);
    }
  }

  requestAnimationFrame(npcFrame);
}

requestAnimationFrame(npcFrame);
