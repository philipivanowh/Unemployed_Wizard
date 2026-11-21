// "Take me there": asks for your location (explaining why first, then the browser's own
// permission prompt), draws a walking route along the walkways to an event, and shows the
// distance, walking time and arrival time, updating as you move. A guide walks the route
// ahead of you. Loaded as a plain script after npc.ts, walk-graph.ts and routine.ts.

/** Line icons for the dialogs (fixed markup, no user text). */
const ROUTE_ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>',
};

/** Typical walking pace (about 4.9 km/h). */
const WALK_METERS_PER_SECOND = 1.35;
/** Close enough to count as arrived. */
const ARRIVED_METERS = 30;
/** Re-plan the route after moving this far. */
const REROUTE_METERS = 20;
/** Farther than this (straight line), walking directions stop making sense. */
const FAR_METERS = 6000;

interface GuideTarget {
  id: string;
  title: string;
  latitude: number;
  longitude: number;
}

interface RouteGuideOptions {
  map: L.Map;
  graph: () => WalkGraph | null;
  toPoint: (lat: number, lng: number) => WalkPoint;
  toLatLng: (p: WalkPoint) => L.LatLng;
  /** Called while a route is shown (so the map can let you pan past its area) and when it ends. */
  onActiveChange?: (active: boolean) => void;
  /** Starts a guide walking `points` (map coordinates), or removes it when null. */
  onGuide?: (points: WalkPoint[] | null, target: GuideTarget | null) => void;
}

type RouteState = "locating" | "active" | "arrived" | "far";

/** A guide who walks the route ahead of you, then waits at the event. */
class RouteGuideWalker implements Walker {
  readonly name = "Your guide";
  readonly npc: Npc;
  status: string;
  done = false;
  private targetOpacity = 1;

  constructor(npc: Npc, points: WalkPoint[], title: string) {
    this.npc = npc;
    const first = points[0] ?? { x: 0, y: 0 };
    npc.x = first.x;
    npc.y = first.y;
    npc.opacity = 0;
    npc.speed = 70 * NPC_SIZE;
    this.status = `Follow me to ${title}`;
    void npc.followPath(points.slice(1)).then((arrived) => {
      if (!arrived) return;
      this.status = `Waiting for you at ${title}`;
      npc.face("down");
    });
  }

  dismiss(): void {
    this.targetOpacity = 0;
  }

  update(dt: number): void {
    const fade = dt * 2;
    this.npc.opacity += Math.max(-fade, Math.min(fade, this.targetOpacity - this.npc.opacity));
    if (this.targetOpacity === 0 && this.npc.opacity <= 0) this.done = true;
    this.npc.update(dt);
  }
}

class RouteGuide {
  private readonly o: RouteGuideOptions;
  private readonly layer: L.LayerGroup;
  private target: GuideTarget | null = null;
  private watchId: number | null = null;
  private user: L.LatLng | null = null;
  private routedFrom: L.LatLng | null = null;
  private startDistance = 0;
  private routeBounds: L.LatLngBounds | null = null;
  private userMarker: L.Marker | null = null;
  private accuracyCircle: L.Circle | null = null;
  private state: RouteState = "locating";

  // Route card
  private readonly card: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly statEta: HTMLElement;
  private readonly statEtaUnit: HTMLElement;
  private readonly statDistance: HTMLElement;
  private readonly statDistanceUnit: HTMLElement;
  private readonly statArrive: HTMLElement;
  private readonly statArriveUnit: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly note: HTMLElement;
  private readonly recenterButton: HTMLButtonElement;

  // Dialog (permission explanation, errors)
  private readonly backdrop: HTMLElement;

  constructor(options: RouteGuideOptions) {
    this.o = options;
    this.layer = L.layerGroup().addTo(options.map);

    const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    // --- Route card -------------------------------------------------------
    this.card = h("section", "route-card");
    this.card.setAttribute("aria-label", "Walking route");
    this.card.hidden = true;
    const head = h("div", "route-head");
    const kicker = h("span", "route-kicker", "Walking route");
    const close = h("button", "route-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "End route");
    close.addEventListener("click", () => this.stop());
    head.append(kicker, close);
    this.cardTitle = h("h2", "route-title");

    this.stats = h("div", "route-stats");
    const stat = (unit: string): [HTMLElement, HTMLElement, HTMLElement] => {
      const box = h("div", "route-stat");
      const value = h("b", undefined, "–");
      const label = h("span", undefined, unit);
      box.append(value, label);
      return [box, value, label];
    };
    const [etaBox, eta, etaUnit] = stat("min walk");
    const [distBox, dist, distUnit] = stat("distance");
    const [arriveBox, arrive, arriveUnit] = stat("arrival");
    this.statEta = eta;
    this.statEtaUnit = etaUnit;
    this.statDistance = dist;
    this.statDistanceUnit = distUnit;
    this.statArrive = arrive;
    this.statArriveUnit = arriveUnit;
    this.stats.append(etaBox, distBox, arriveBox);

    const bar = h("div", "route-progress");
    this.progress = h("i");
    bar.append(this.progress);
    bar.setAttribute("aria-hidden", "true");

    this.note = h("p", "route-note");
    this.note.setAttribute("role", "status");

    const actions = h("div", "route-actions");
    this.recenterButton = h("button", "route-btn", "Recenter");
    this.recenterButton.type = "button";
    this.recenterButton.addEventListener("click", () => this.fit());
    const end = h("button", "route-btn route-btn-end", "End route");
    end.type = "button";
    end.addEventListener("click", () => this.stop());
    actions.append(this.recenterButton, end);

    this.card.append(head, this.cardTitle, this.stats, bar, this.note, actions);
    document.body.append(this.card);

    // --- Dialog -------------------------------------------------------------
    this.backdrop = h("div", "sheet-backdrop");
    this.backdrop.hidden = true;
    document.body.append(this.backdrop);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.backdrop.hidden) this.closeDialog(false);
    });
  }

  get active(): boolean {
    return this.target !== null;
  }

  /** Start guiding to an event: permission first, then the route. */
  async start(target: GuideTarget): Promise<void> {
    this.stop();
    if (!(await this.ensurePermission())) return;

    this.target = target;
    this.state = "locating";
    this.cardTitle.textContent = target.title;
    this.showCard("Finding your location…", "busy");
    this.o.onActiveChange?.(true);

    let position: GeolocationPosition;
    try {
      position = await this.locateOnce();
    } catch (err) {
      this.stop();
      this.showLocationError(err as GeolocationPositionError);
      return;
    }
    if (this.target !== target) return; // cancelled meanwhile
    this.onPosition(position, true);

    // Keep following the user as they walk.
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p, false),
      () => this.setNote("Lost your location for a moment. Retrying…", "warn"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    const wasActive = this.target !== null;
    this.target = null;
    this.user = null;
    this.routedFrom = null;
    this.routeBounds = null;
    this.userMarker = null;
    this.accuracyCircle = null;
    this.layer.clearLayers();
    this.card.hidden = true;
    this.o.onGuide?.(null, null);
    if (wasActive) this.o.onActiveChange?.(false);
  }

  // -------------------------------------------------------------------------
  // Permission

  private async ensurePermission(): Promise<boolean> {
    if (!("geolocation" in navigator)) {
      await this.dialog({
        icon: "alert",
        title: "Location isn't available",
        body: ["This browser can't share your location, so we can't draw a route from where you are."],
        primary: "OK",
      });
      return false;
    }
    let state: PermissionState | "unknown" = "unknown";
    try {
      state = (await navigator.permissions.query({ name: "geolocation" })).state;
    } catch {
      // Some browsers don't support checking; just ask.
    }
    if (state === "granted") return true;
    if (state === "denied") {
      await this.showDenied();
      return false;
    }
    return this.dialog({
      icon: "pin",
      title: "Use your location?",
      body: [
        "To draw a walking route, we need to know where you are. Your browser will ask for permission next.",
        "Your location stays on this device. It's only used to draw the route, and isn't saved or sent anywhere.",
      ],
      primary: "Allow location",
      secondary: "Not now",
    });
  }

  private locateOnce(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 30000,
      }),
    );
  }

  private async showLocationError(err: GeolocationPositionError | undefined): Promise<void> {
    if (err?.code === 1) return this.showDenied();
    await this.dialog({
      icon: "alert",
      title: err?.code === 3 ? "That took too long" : "Couldn't find your location",
      body: [
        err?.code === 3
          ? "Your device didn't report a location in time. Move somewhere with a clearer signal and try again."
          : "Make sure location services are turned on for this device and browser, then try again.",
      ],
      primary: "OK",
    });
  }

  private async showDenied(): Promise<void> {
    await this.dialog({
      icon: "lock",
      title: "Location is blocked",
      body: [
        "This site isn't allowed to use your location, so we can't draw a route from where you are.",
        "To allow it: click the lock or settings icon next to the address bar, set Location to Allow, then try again.",
      ],
      primary: "Got it",
    });
  }

  // -------------------------------------------------------------------------
  // Positions and routes

  private onPosition(position: GeolocationPosition, first: boolean): void {
    if (!this.target) return;
    const here = L.latLng(position.coords.latitude, position.coords.longitude);
    this.user = here;
    this.drawUser(here, position.coords.accuracy);

    const goal = L.latLng(this.target.latitude, this.target.longitude);
    const straight = here.distanceTo(goal);
    if (straight > FAR_METERS) {
      this.state = "far";
      this.layer.eachLayer((l) => {
        if (l !== this.userMarker && l !== this.accuracyCircle) this.layer.removeLayer(l);
      });
      this.addDestination(goal);
      this.showFar(straight);
      if (first) this.o.onGuide?.(null, null);
      return;
    }

    if (first || !this.routedFrom || here.distanceTo(this.routedFrom) > REROUTE_METERS) {
      this.route(here, goal, first);
    }
    if (straight <= ARRIVED_METERS && this.state !== "arrived") {
      this.state = "arrived";
      this.renderArrived();
    }
  }

  private route(from: L.LatLng, goal: L.LatLng, first: boolean): void {
    if (!this.target) return;
    this.routedFrom = from;
    const graph = this.o.graph();
    let path: L.LatLng[] = [];
    let guidePoints: WalkPoint[] = [];
    if (graph) {
      const fromPt = this.o.toPoint(from.lat, from.lng);
      const goalPt = this.o.toPoint(goal.lat, goal.lng);
      const a = graph.nearest(fromPt.x, fromPt.y);
      const b = graph.nearest(goalPt.x, goalPt.y);
      const nodes = graph.route(a, b) ?? [a, b];
      path = nodes.map((n) => this.o.toLatLng(graph.point(n)));
      guidePoints = [fromPt, ...nodes.map((n) => graph.point(n)), goalPt];
    }

    // Walk to the nearest path (dashed if it's a real gap), along the paths, then to the door.
    const entry = path[0] ?? from;
    const lead = from.distanceTo(entry);
    let distance = lead + (path.length ? path[path.length - 1]!.distanceTo(goal) : from.distanceTo(goal));
    for (let i = 1; i < path.length; i++) distance += path[i - 1]!.distanceTo(path[i]!);
    const line = path.length ? [...path, goal] : [from, goal];

    this.layer.eachLayer((l) => {
      if (l !== this.userMarker && l !== this.accuracyCircle) this.layer.removeLayer(l);
    });
    if (lead > 15) {
      L.polyline([from, entry], { color: "#4f46e5", weight: 4, opacity: 0.8, dashArray: "1 9", lineCap: "round", interactive: false }).addTo(this.layer);
    }
    L.polyline(line, { color: "#ffffff", weight: 11, opacity: 0.95, lineJoin: "round", lineCap: "round", interactive: false }).addTo(this.layer);
    L.polyline(line, { color: "#4f46e5", weight: 6, lineJoin: "round", lineCap: "round", interactive: false }).addTo(this.layer);
    L.polyline(line, { color: "#c7d2fe", weight: 2, dashArray: "2 12", lineCap: "round", className: "route-flow", interactive: false }).addTo(this.layer);
    this.addDestination(goal);

    this.routeBounds = L.latLngBounds([from, goal, ...line]);
    if (first) {
      this.startDistance = distance;
      this.fit();
      if (guidePoints.length) this.o.onGuide?.(guidePoints, this.target);
    }
    this.state = from.distanceTo(goal) <= ARRIVED_METERS ? "arrived" : "active";
    if (this.state === "arrived") this.renderArrived();
    else this.renderRoute(distance, lead > 15);
  }

  private drawUser(at: L.LatLng, accuracy: number): void {
    if (!this.userMarker) {
      this.accuracyCircle = L.circle(at, {
        radius: accuracy,
        color: "#2563eb",
        weight: 1,
        opacity: 0.3,
        fillColor: "#3b82f6",
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(this.layer);
      this.userMarker = L.marker(at, {
        icon: L.divIcon({ className: "user-dot", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
        title: "You are here",
        zIndexOffset: 1000,
      }).addTo(this.layer);
    } else {
      this.userMarker.setLatLng(at);
      this.accuracyCircle?.setLatLng(at).setRadius(accuracy);
    }
  }

  private addDestination(goal: L.LatLng): void {
    L.marker(goal, {
      icon: L.divIcon({ className: "route-dest", html: "<span></span>", iconSize: [44, 44], iconAnchor: [22, 22] }),
      interactive: false,
      keyboard: false,
    }).addTo(this.layer);
  }

  private fit(): void {
    if (!this.routeBounds) return;
    const mobile = window.innerWidth < 640;
    this.o.map.fitBounds(this.routeBounds, {
      paddingTopLeft: [mobile ? 24 : 380, 40],
      paddingBottomRight: [40, mobile ? 300 : 40],
      maxZoom: 18,
    });
  }

  // -------------------------------------------------------------------------
  // Card

  private showCard(note: string, noteState: "busy" | "ok" | "warn" | "done"): void {
    this.card.hidden = false;
    this.card.dataset.state = this.state;
    this.stats.hidden = this.state === "locating";
    this.recenterButton.hidden = this.state === "locating";
    this.progress.parentElement!.hidden = this.state === "locating" || this.state === "far";
    this.setNote(note, noteState);
  }

  private setNote(text: string, state: "busy" | "ok" | "warn" | "done"): void {
    this.note.textContent = text;
    this.note.dataset.state = state;
  }

  private renderRoute(meters: number, offPath: boolean): void {
    const seconds = meters / WALK_METERS_PER_SECOND;
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) {
      this.statEta.textContent = String(minutes);
      this.statEtaUnit.textContent = minutes === 1 ? "min walk" : "min walk";
    } else {
      this.statEta.textContent = `${Math.floor(minutes / 60)}h ${minutes % 60}`;
      this.statEtaUnit.textContent = "walk";
    }
    if (meters < 1000) {
      this.statDistance.textContent = String(Math.round(meters / 10) * 10);
      this.statDistanceUnit.textContent = "metres";
    } else {
      this.statDistance.textContent = (meters / 1000).toFixed(1);
      this.statDistanceUnit.textContent = "km";
    }
    const arrival = new Date(Date.now() + seconds * 1000);
    const parts = arrival.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).split(" ");
    this.statArrive.textContent = parts[0] ?? "";
    this.statArriveUnit.textContent = parts[1] ? `${parts[1]} arrival` : "arrival";
    const done = this.startDistance > 0 ? 1 - meters / this.startDistance : 0;
    this.progress.style.width = `${Math.round(Math.max(0.03, Math.min(1, done)) * 100)}%`;
    this.showCard(
      offPath ? "Dotted line: walk to the nearest path first. Following your location." : "Following your location as you walk.",
      "ok",
    );
  }

  private renderArrived(): void {
    this.statEta.textContent = "0";
    this.statDistance.textContent = "0";
    this.statDistanceUnit.textContent = "metres";
    this.statArrive.textContent = "Now";
    this.statArriveUnit.textContent = "you're here";
    this.progress.style.width = "100%";
    this.showCard("You've arrived. Enjoy the free stuff!", "done");
  }

  private showFar(meters: number): void {
    this.statEta.textContent = "–";
    this.statDistance.textContent = (meters / 1000).toFixed(meters < 100_000 ? 1 : 0);
    this.statDistanceUnit.textContent = "km away";
    this.statArrive.textContent = "–";
    this.statArriveUnit.textContent = "arrival";
    this.routeBounds = null;
    this.showCard("You're too far away to walk there. Routes appear once you're within a few kilometres.", "warn");
  }

  // -------------------------------------------------------------------------
  // Dialog

  private resolveDialog: ((ok: boolean) => void) | null = null;
  private lastFocus: Element | null = null;

  private dialog(options: { icon: keyof typeof ROUTE_ICONS; title: string; body: string[]; primary: string; secondary?: string }): Promise<boolean> {
    this.lastFocus = document.activeElement;
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "sheet-title");
    const icon = document.createElement("div");
    icon.className = "sheet-icon";
    icon.innerHTML = ROUTE_ICONS[options.icon];
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("h2");
    title.id = "sheet-title";
    title.textContent = options.title;
    sheet.append(icon, title);
    for (const text of options.body) {
      const p = document.createElement("p");
      p.textContent = text;
      sheet.append(p);
    }
    const actions = document.createElement("div");
    actions.className = "sheet-actions";
    if (options.secondary) {
      const no = document.createElement("button");
      no.type = "button";
      no.className = "route-btn";
      no.textContent = options.secondary;
      no.addEventListener("click", () => this.closeDialog(false));
      actions.append(no);
    }
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "route-btn route-btn-primary";
    yes.textContent = options.primary;
    yes.addEventListener("click", () => this.closeDialog(true));
    actions.append(yes);
    sheet.append(actions);

    this.backdrop.replaceChildren(sheet);
    this.backdrop.hidden = false;
    yes.focus();
    return new Promise((resolve) => {
      this.resolveDialog = resolve;
    });
  }

  private closeDialog(ok: boolean): void {
    this.backdrop.hidden = true;
    this.backdrop.replaceChildren();
    const resolve = this.resolveDialog;
    this.resolveDialog = null;
    resolve?.(ok);
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }
}
