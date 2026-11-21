// Crowds at live events: while an event is on, people walk in along the walkways and
// gather around its pin; when it ends, they head off. So the map shows where things
// are happening right now. Loaded as a plain script after npc.ts, walk-graph.ts and routine.ts.

/** People in each event's crowd. */
const CROWD_SIZE = 7;
/** People start arriving this many minutes before the start. */
const CROWD_ARRIVE_EARLY_MINUTES = 20;
/** Events without an end time are treated as lasting this long. */
const DEFAULT_EVENT_MINUTES = 120;

interface CrowdEvent {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string | null;
  latitude: number;
  longitude: number;
}

/** When an event starts and ends, as dates. */
function eventWindow(event: CrowdEvent): { start: Date; end: Date } {
  const start = new Date(`${event.date}T${event.startTime}:00`);
  const end = event.endTime
    ? new Date(`${event.date}T${event.endTime}:00`)
    : new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000);
  return { start, end };
}

type EventPhase = "upcoming" | "soon" | "live" | "over";

/** "soon" is the arrival window just before the start. */
function eventPhase(event: CrowdEvent, now: Date): EventPhase {
  const { start, end } = eventWindow(event);
  if (now >= end) return "over";
  if (now >= start) return "live";
  if (now.getTime() >= start.getTime() - CROWD_ARRIVE_EARLY_MINUTES * 60_000) return "soon";
  return "upcoming";
}

/** One person in an event's crowd. */
class Attendee implements Walker {
  readonly name: string;
  readonly npc: Npc;
  status: string;
  done = false;

  private readonly graph: WalkGraph;
  private readonly title: string;
  private readonly spot: WalkPoint;
  private readonly center: WalkPoint;
  private targetOpacity = 1;
  private leaving = false;
  private shuffleIn: number;

  constructor(npc: Npc, graph: WalkGraph, eventNode: number, title: string, spot: WalkPoint, alreadyThere: boolean) {
    this.npc = npc;
    this.graph = graph;
    this.title = title;
    this.spot = spot;
    this.center = graph.point(eventNode);
    this.name = takeResidentName(Math.random);
    this.shuffleIn = 3 + Math.random() * 8;

    if (alreadyThere) {
      this.place(spot);
      this.status = `At ${title}`;
      this.faceCenter();
    } else {
      // Walk in from a few streets away.
      const from = graph.stroll(eventNode, 15 + Math.floor(Math.random() * 30)).pop() ?? eventNode;
      this.place(graph.point(from));
      npc.opacity = 0;
      this.status = `Heading to ${title}`;
      const route = graph.routePoints(from, eventNode) ?? [];
      void npc.followPath([...route, spot]).then((arrived) => {
        if (arrived && !this.leaving) {
          this.status = `At ${title}`;
          this.faceCenter();
        }
      });
    }
  }

  /** The event's over: walk away and fade out. */
  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.status = `Leaving ${this.title}`;
    const from = this.graph.nearest(this.npc.x, this.npc.y);
    const to = this.graph.stroll(from, 15 + Math.floor(Math.random() * 25)).pop() ?? from;
    const route = this.graph.routePoints(from, to) ?? [];
    void this.npc.followPath([this.graph.point(from), ...route]).then(() => {
      this.targetOpacity = 0;
    });
  }

  update(dt: number): void {
    // Shuffle around the spot a little, like people chatting in a group.
    if (!this.leaving && this.npc.state === "idle" && this.status.startsWith("At ")) {
      this.shuffleIn -= dt;
      if (this.shuffleIn <= 0) {
        this.shuffleIn = 4 + Math.random() * 10;
        const jitter = () => (Math.random() - 0.5) * 6;
        void this.npc.followPath([{ x: this.spot.x + jitter(), y: this.spot.y + jitter() }]).then(() => this.faceCenter());
      }
    }
    const fade = dt * 1.5;
    this.npc.opacity += Math.max(-fade, Math.min(fade, this.targetOpacity - this.npc.opacity));
    if (this.leaving && this.targetOpacity === 0 && this.npc.opacity <= 0) this.done = true;
    this.npc.update(dt);
  }

  private place(p: WalkPoint): void {
    this.npc.x = p.x;
    this.npc.y = p.y;
  }

  private faceCenter(): void {
    const dx = this.center.x - this.npc.x;
    const dy = this.center.y - this.npc.y;
    const c = Math.cos(this.npc.viewRotation);
    const s = Math.sin(this.npc.viewRotation);
    const sx = dx * c - dy * s;
    const sy = dx * s + dy * c;
    this.npc.face(Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : sy > 0 ? "down" : "up");
  }
}

/** Keeps a crowd at every event that's on (or about to start), and sends them home after. */
class CrowdManager {
  private readonly graph: WalkGraph;
  private readonly toPoint: (lat: number, lng: number) => WalkPoint;
  private readonly spawn: (attendee: Attendee) => void;
  private readonly makeNpc: () => Npc;
  private readonly crowds = new Map<string, Attendee[]>();

  constructor(
    graph: WalkGraph,
    toPoint: (lat: number, lng: number) => WalkPoint,
    makeNpc: () => Npc,
    spawn: (attendee: Attendee) => void,
  ) {
    this.graph = graph;
    this.toPoint = toPoint;
    this.makeNpc = makeNpc;
    this.spawn = spawn;
  }

  /** Call regularly with the current events; adds and removes crowds to match. */
  sync(events: CrowdEvent[], now: Date, firstSync: boolean): void {
    const wanted = new Set<string>();
    for (const event of events) {
      const phase = eventPhase(event, now);
      if (phase !== "soon" && phase !== "live") continue;
      wanted.add(event.id);
      if (this.crowds.has(event.id)) continue;
      // On page load, a live event's crowd is already gathered.
      this.crowds.set(event.id, this.gather(event, firstSync && phase === "live"));
    }
    for (const [id, crowd] of this.crowds) {
      if (wanted.has(id)) continue;
      for (const person of crowd) person.leave();
      this.crowds.delete(id);
    }
  }

  /** How many crowds are gathered or gathering. */
  get size(): number {
    return this.crowds.size;
  }

  private gather(event: CrowdEvent, alreadyThere: boolean): Attendee[] {
    const p = this.toPoint(event.latitude, event.longitude);
    const node = this.graph.nearest(p.x, p.y);
    const center = this.graph.point(node);
    const people: Attendee[] = [];
    for (let i = 0; i < CROWD_SIZE; i++) {
      // A loose ring around the pin, a few metres out.
      const angle = (i / CROWD_SIZE) * Math.PI * 2 + Math.random() * 0.6;
      const radius = 6 + Math.random() * 9;
      const spot = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
      const person = new Attendee(this.makeNpc(), this.graph, node, event.title, spot, alreadyThere);
      people.push(person);
      this.spawn(person);
    }
    return people;
  }
}
