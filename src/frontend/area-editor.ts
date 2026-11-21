// Area editor (/area-editor.html): edit DOWNTOWN_AREAS and DOWNTOWN_SPOTS on a map,
// then copy the generated code over src/frontend/area-data.ts.
// Wrapped in a function so its names don't clash with the other page scripts.

(() => {
  type Pair = [number, number];
  interface EditorArea {
    name: string;
    ring: Pair[];
  }
  interface EditorSpot {
    name: string;
    lat: number;
    lng: number;
  }
  interface EditorState {
    areas: EditorArea[];
    spots: EditorSpot[];
  }

  const DRAFT_KEY = "area-editor-draft";
  const round = (n: number) => Math.round(n * 1e5) / 1e5; // 5 decimals is about 1 m
  const fmt = (lat: number, lng: number) => `[${round(lat)}, ${round(lng)}]`;
  const clone = (s: EditorState) => JSON.parse(JSON.stringify(s)) as EditorState;

  const fileState: EditorState = {
    areas: DOWNTOWN_AREAS.map((a) => ({ name: a.name, ring: a.ring.map(([lat, lng]): Pair => [lat, lng]) })),
    spots: DOWNTOWN_SPOTS.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
  };
  const fileFingerprint = JSON.stringify(fileState);

  // Unsaved edits survive a page refresh, as long as area-data.ts hasn't changed since.
  function loadDraft(): EditorState | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw) as { base: string; state: EditorState };
      return draft.base === fileFingerprint ? draft.state : null;
    } catch {
      return null;
    }
  }

  function saveDraft(): void {
    try {
      if (JSON.stringify(state) === fileFingerprint) localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, JSON.stringify({ base: fileFingerprint, state }));
    } catch {
      // Storage unavailable: edits just aren't kept across refreshes.
    }
  }

  let state: EditorState = loadDraft() ?? clone(fileState);
  let selected = state.areas.length > 0 ? 0 : -1;
  const history: string[] = [];
  const clicked: Pair[] = [];

  // -------------------------------------------------------------------------
  // DOM

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`#${id} is missing from the page`);
    return element as T;
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", undefined, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  const areaList = byId<HTMLDivElement>("area-list");
  const areaName = byId<HTMLInputElement>("area-name");
  const spotSummary = byId<HTMLDivElement>("spot-summary");
  const clickedList = byId<HTMLUListElement>("clicked-points");
  const output = byId<HTMLTextAreaElement>("output");
  const draftNote = byId<HTMLDivElement>("draft-note");
  const toastEl = byId<HTMLDivElement>("toast");
  const deleteAreaButton = byId<HTMLButtonElement>("delete-area");

  let toastTimer = 0;
  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  async function copy(text: string, message = `Copied ${text}`): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast("Couldn't copy automatically; select the text and copy it");
    }
  }

  // -------------------------------------------------------------------------
  // Map

  const map = L.map("editor-map", { zoomSnap: 0.25, doubleClickZoom: false, boxZoom: false });
  const startPoints: Pair[] = [
    ...state.areas.flatMap((a) => a.ring),
    ...state.spots.map((s): Pair => [s.lat, s.lng]),
  ];
  if (startPoints.length >= 2) map.fitBounds(L.latLngBounds(startPoints).pad(0.1));
  else map.setView([45.505, -73.567], 14);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const shapesLayer = L.layerGroup().addTo(map);
  const handlesLayer = L.layerGroup().addTo(map);
  const spotsLayer = L.layerGroup().addTo(map);
  let selectedShape: L.Polygon | null = null;

  const vertexIcon = L.divIcon({ className: "vertex-handle", iconSize: [12, 12] });
  const midIcon = L.divIcon({ className: "mid-handle", iconSize: [10, 10] });
  const spotIcon = (inside: boolean) =>
    L.divIcon({ className: `spot-handle ${inside ? "spot-in" : "spot-out"}`, iconSize: [14, 14] });

  const insideAnyArea = (lat: number, lng: number) =>
    state.areas.some((a) => a.ring.length >= 3 && isPointInRing(lat, lng, a.ring));

  // -------------------------------------------------------------------------
  // Edits (each one is undoable)

  function pushHistory(): void {
    history.push(JSON.stringify(state));
    if (history.length > 200) history.shift();
  }

  function changed(): void {
    saveDraft();
    render();
  }

  function commit(mutate: () => void): void {
    pushHistory();
    mutate();
    changed();
  }

  function undo(): void {
    const previous = history.pop();
    if (!previous) {
      toast("Nothing to undo");
      return;
    }
    state = JSON.parse(previous) as EditorState;
    selected = Math.min(selected, state.areas.length - 1);
    if (selected < 0 && state.areas.length > 0) selected = 0;
    changed();
    toast("Undone");
  }

  /** Where a new point belongs: on the edge closest to it (in screen pixels). */
  function insertIndexFor(ring: Pair[], latlng: L.LatLng): number {
    if (ring.length < 2) return ring.length;
    const p = map.latLngToLayerPoint(latlng);
    let best = ring.length;
    let bestDistance = Infinity;
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      const distance = L.LineUtil.pointToSegmentDistance(
        p,
        map.latLngToLayerPoint(a),
        map.latLngToLayerPoint(b),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i + 1;
      }
    });
    return best;
  }

  function addPointToSelected(latlng: L.LatLng): void {
    const area = state.areas[selected];
    if (!area) {
      toast("Create or select an area first");
      return;
    }
    commit(() => area.ring.splice(insertIndexFor(area.ring, latlng), 0, [round(latlng.lat), round(latlng.lng)]));
    toast(`Added ${fmt(latlng.lat, latlng.lng)} to ${area.name}`);
  }

  function deletePoint(area: EditorArea, index: number): void {
    commit(() => area.ring.splice(index, 1));
    toast(`Deleted point ${index + 1}`);
  }

  function addSpot(latlng: L.LatLng): void {
    const name = window.prompt("Name for this NPC spot", "New spot");
    if (name === null) return;
    commit(() => state.spots.push({ name: name.trim() || "New spot", lat: round(latlng.lat), lng: round(latlng.lng) }));
  }

  function deleteSpot(index: number): void {
    const spot = state.spots[index];
    if (!spot) return;
    commit(() => state.spots.splice(index, 1));
    toast(`Deleted spot "${spot.name}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering

  function render(): void {
    shapesLayer.clearLayers();
    handlesLayer.clearLayers();
    spotsLayer.clearLayers();
    selectedShape = null;

    state.areas.forEach((area, index) => {
      if (area.ring.length < 2) return;
      const isSelected = index === selected;
      const shape = L.polygon(area.ring, {
        color: isSelected ? "#ea580c" : "#2563eb",
        weight: isSelected ? 3 : 2,
        dashArray: isSelected ? undefined : "6 4",
        fillOpacity: isSelected ? 0.15 : 0.06,
        interactive: false,
      }).addTo(shapesLayer);
      if (isSelected) selectedShape = shape;
    });

    const area = state.areas[selected];
    if (area) renderHandles(area);
    renderSpots();
    renderSidebar();
    output.value = generateCode();
  }

  function renderHandles(area: EditorArea): void {
    area.ring.forEach(([lat, lng], i) => {
      const handle = L.marker([lat, lng], {
        icon: vertexIcon,
        draggable: true,
        keyboard: false,
        title: `Point ${i + 1}: ${fmt(lat, lng)}`,
      }).addTo(handlesLayer);
      handle.on("dragstart", pushHistory);
      handle.on("drag", () => {
        const p = handle.getLatLng();
        area.ring[i] = [p.lat, p.lng];
        selectedShape?.setLatLngs(area.ring);
      });
      handle.on("dragend", () => {
        const p = handle.getLatLng();
        area.ring[i] = [round(p.lat), round(p.lng)];
        changed();
      });
      handle.on("click", (e: L.LeafletMouseEvent) => {
        const point = area.ring[i]!;
        if (e.originalEvent.altKey) deletePoint(area, i);
        else void copy(fmt(point[0], point[1]), `Point ${i + 1}: copied ${fmt(point[0], point[1])}`);
      });
      handle.on("contextmenu", () => deletePoint(area, i));
    });

    // Faded dots halfway along each edge: click or drag one to add a point there.
    if (area.ring.length < 2) return;
    const edges = area.ring.length === 2 ? 1 : area.ring.length;
    for (let i = 0; i < edges; i++) {
      const a = area.ring[i]!;
      const b = area.ring[(i + 1) % area.ring.length]!;
      const mid: Pair = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const handle = L.marker(mid, { icon: midIcon, draggable: true, keyboard: false, title: "Add a point here" }).addTo(
        handlesLayer,
      );
      handle.on("dragstart", () => {
        pushHistory();
        area.ring.splice(i + 1, 0, mid);
      });
      handle.on("drag", () => {
        const p = handle.getLatLng();
        area.ring[i + 1] = [p.lat, p.lng];
        selectedShape?.setLatLngs(area.ring);
      });
      handle.on("dragend", () => {
        const p = handle.getLatLng();
        area.ring[i + 1] = [round(p.lat), round(p.lng)];
        changed();
      });
      handle.on("click", () => commit(() => area.ring.splice(i + 1, 0, [round(mid[0]), round(mid[1])])));
    }
  }

  function renderSpots(): void {
    state.spots.forEach((spot, i) => {
      const inside = insideAnyArea(spot.lat, spot.lng);
      const marker = L.marker([spot.lat, spot.lng], {
        icon: spotIcon(inside),
        draggable: true,
        keyboard: false,
      }).addTo(spotsLayer);
      marker.bindTooltip(inside ? spot.name : `${spot.name} (outside the area)`, {
        direction: "top",
        offset: [0, -8],
      });
      marker.on("dragstart", pushHistory);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        spot.lat = round(p.lat);
        spot.lng = round(p.lng);
        changed();
      });
      marker.on("click", (e: L.LeafletMouseEvent) => {
        if (e.originalEvent.altKey) {
          deleteSpot(i);
          return;
        }
        const name = window.prompt("Rename spot", spot.name);
        if (name !== null && name.trim() && name.trim() !== spot.name) commit(() => (spot.name = name.trim()));
      });
      marker.on("contextmenu", () => deleteSpot(i));
    });
  }

  function renderAreaList(): void {
    areaList.replaceChildren(
      ...state.areas.map((area, i) => {
        const item = el("div", `area-item${i === selected ? " selected" : ""}`);
        const radio = el("input");
        radio.type = "radio";
        radio.name = "area";
        radio.checked = i === selected;
        radio.setAttribute("aria-label", area.name);
        const tooFew = area.ring.length < 3;
        item.append(
          radio,
          el("span", undefined, area.name || "(unnamed)"),
          el("span", `count${tooFew ? " bad" : ""}`, tooFew ? `${area.ring.length} points (needs 3+)` : `${area.ring.length} points`),
        );
        item.addEventListener("click", () => {
          selected = i;
          render();
        });
        return item;
      }),
    );
    if (state.areas.length === 0) areaList.append(el("div", "help", "No areas. Click New area to start one."));
  }

  function renderSidebar(): void {
    renderAreaList();
    const area = state.areas[selected];
    if (document.activeElement !== areaName) areaName.value = area?.name ?? "";
    areaName.disabled = !area;
    deleteAreaButton.disabled = !area;

    const outside = state.spots.filter((s) => !insideAnyArea(s.lat, s.lng));
    spotSummary.replaceChildren(
      el("div", undefined, `${state.spots.length} spots · green is inside an area, red is outside`),
    );
    if (outside.length > 0) {
      spotSummary.append(
        el("div", "bad", `Outside the area (the NPC skips these): ${outside.map((s) => s.name).join(", ")}`),
      );
    }
    spotSummary.append(el("div", "help", "Click a spot to rename it, drag to move it."));

    const unsaved = JSON.stringify(state) !== fileFingerprint;
    draftNote.textContent = unsaved
      ? "Unsaved changes: kept in this browser until you paste them into area-data.ts or reset."
      : "Matches area-data.ts.";
    draftNote.className = unsaved ? "warn" : "help";
  }

  function renderClicked(): void {
    clickedList.replaceChildren(
      ...clicked.map(([lat, lng]) => {
        const item = el("li");
        item.append(el("span", "coords", fmt(lat, lng)), button("Copy", () => void copy(fmt(lat, lng))));
        return item;
      }),
    );
    if (clicked.length === 0) clickedList.append(el("li", undefined, "Click the map to collect points."));
  }

  function generateCode(): string {
    const quote = (s: string) => JSON.stringify(s);
    const ring = (points: Pair[]) => {
      if (points.length === 0) return "    ring: [],";
      const rows: string[] = [];
      for (let i = 0; i < points.length; i += 4) {
        rows.push(`      ${points.slice(i, i + 4).map(([lat, lng]) => fmt(lat, lng)).join(", ")},`);
      }
      return `    ring: [\n${rows.join("\n")}\n    ],`;
    };
    const areas = state.areas.map((a) => `  {\n    name: ${quote(a.name)},\n${ring(a.ring)}\n  },`).join("\n");
    const spots = state.spots
      .map((s) => `  { name: ${quote(s.name)}, lat: ${round(s.lat)}, lng: ${round(s.lng)} },`)
      .join("\n");
    return `// The part of Montreal the event map is limited to, plus the places the NPC wanders to.
// Edit this visually at /area-editor.html, then paste its output over this whole file.
// Original outlines: OpenStreetMap (© OpenStreetMap contributors, ODbL). Points are [lat, lng].

interface DowntownArea {
  name: string;
  ring: [number, number][];
}

const DOWNTOWN_AREAS: DowntownArea[] = [
${areas}
];

/** Places on land the NPC wanders between (random points could land in the river). */
const DOWNTOWN_SPOTS: { name: string; lat: number; lng: number }[] = [
${spots}
];
`;
  }

  function openCoordinatePopup(latlng: L.LatLng): void {
    const text = fmt(latlng.lat, latlng.lng);
    const box = el("div", "coord-popup");
    box.append(el("div", "coords", text));
    const row = el("div", "row");
    const area = state.areas[selected];
    row.append(button("Copy", () => void copy(text)));
    if (area) {
      row.append(
        button(`Add to ${area.name}`, () => {
          map.closePopup();
          addPointToSelected(latlng);
        }),
      );
    }
    row.append(
      button("Add NPC spot", () => {
        map.closePopup();
        addSpot(latlng);
      }),
    );
    box.append(row);
    L.popup({ autoPan: false }).setLatLng(latlng).setContent(box).openOn(map);
  }

  // -------------------------------------------------------------------------
  // Events

  map.on("click", (e: L.LeafletMouseEvent) => {
    if (e.originalEvent.shiftKey) {
      addPointToSelected(e.latlng);
      return;
    }
    clicked.unshift([round(e.latlng.lat), round(e.latlng.lng)]);
    if (clicked.length > 8) clicked.pop();
    renderClicked();
    openCoordinatePopup(e.latlng);
    void copy(fmt(e.latlng.lat, e.latlng.lng));
  });

  let renaming = false;
  areaName.addEventListener("focus", () => (renaming = false));
  areaName.addEventListener("input", () => {
    const area = state.areas[selected];
    if (!area) return;
    if (!renaming) {
      pushHistory();
      renaming = true;
    }
    area.name = areaName.value;
    saveDraft();
    renderSidebar();
    output.value = generateCode();
  });

  byId<HTMLButtonElement>("new-area").addEventListener("click", () => {
    const c = map.getCenter();
    commit(() => {
      state.areas.push({
        name: `Area ${state.areas.length + 1}`,
        ring: [
          [round(c.lat + 0.002), round(c.lng)],
          [round(c.lat - 0.0015), round(c.lng + 0.0025)],
          [round(c.lat - 0.0015), round(c.lng - 0.0025)],
        ],
      });
      selected = state.areas.length - 1;
    });
    toast("New area added in the middle of the map; drag its corners");
  });

  deleteAreaButton.addEventListener("click", () => {
    const area = state.areas[selected];
    if (!area || !window.confirm(`Delete the area "${area.name}"? (You can undo.)`)) return;
    commit(() => {
      state.areas.splice(selected, 1);
      selected = Math.min(selected, state.areas.length - 1);
    });
  });

  byId<HTMLButtonElement>("copy-code").addEventListener("click", () => {
    void copy(output.value, "Copied. Paste it over the whole of src/frontend/area-data.ts");
  });
  byId<HTMLButtonElement>("undo").addEventListener("click", undo);
  byId<HTMLButtonElement>("reset").addEventListener("click", () => {
    if (!window.confirm("Discard your changes and go back to what's in area-data.ts? (You can undo.)")) return;
    commit(() => {
      state = clone(fileState);
      selected = state.areas.length > 0 ? 0 : -1;
    });
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      undo();
    }
  });

  render();
  renderClicked();
})();
