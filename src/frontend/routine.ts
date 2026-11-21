// Daily routines for the map's townspeople, on a clock that follows real time.
// Each resident has a home on the walkway network and a schedule for the day:
// out in the morning, lunch somewhere, an afternoon stroll or visit, an evening
// spot, then home for the night. Loaded as a plain script after npc.ts and walk-graph.ts.

/**
 * How fast the clock runs: 1 is real time (so "live" events are live right now).
 * Raise it to watch a day go by in a demo, e.g. 60 makes an hour pass every minute.
 */
const GAME_SPEED = 1;
/** A routine "day" runs 6:00 AM to 6:00 AM the next morning; 2–6 AM everyone's home. */
const GAME_DAY_START = 6 * 60;
const GAME_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

class GameClock {
  /** The clock's current date and time. */
  now = new Date();
  /** Minutes into the routine day: 6:00 AM is 360, 1:00 AM the next night is 1500. */
  minutes = 0;
  /** Changes at 6:00 AM, when everyone starts a new day from home. */
  day = 0;
  private readonly startedReal = Date.now();
  private readonly startedAt = Date.now();

  constructor() {
    this.update();
  }

  update(): void {
    this.now = new Date(this.startedAt + (Date.now() - this.startedReal) * GAME_SPEED);
    // Shift back 6 hours so the routine day runs 6 AM–6 AM.
    const shifted = new Date(this.now.getTime() - GAME_DAY_START * 60_000);
    this.minutes = GAME_DAY_START + shifted.getHours() * 60 + shifted.getMinutes() + shifted.getSeconds() / 60;
    this.day = shifted.getFullYear() * 1000 + shifted.getMonth() * 40 + shifted.getDate();
  }

  /** Like "Sat 3:47 PM". */
  get label(): string {
    const time = this.now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${GAME_WEEKDAYS[this.now.getDay()]} ${time}`;
  }
}

/** Anyone walking around the map: residents, event crowds, the route guide. */
interface Walker {
  readonly name: string;
  readonly npc: Npc;
  /** What they're up to, in words (shown on hover). */
  status: string;
  /** True once they've left for good; their marker is removed. */
  readonly done?: boolean;
  update(dt: number, clock: GameClock): void;
}

interface RoutinePlace {
  name: string;
  /** Walkway node. */
  node: number;
}

type RoutineActivity = "visit" | "stroll" | "home";

interface RoutineStop {
  /** Game minutes since midnight when they set off. */
  at: number;
  activity: RoutineActivity;
  place?: RoutinePlace;
}

const RESIDENT_NAMES = [
  "Maya", "Leo", "Amara", "Theo", "Sofia", "Kai", "Noor", "Elias", "Chloé", "Mateo", "Yuki", "Samir",
  "Ines", "Felix", "Priya", "Jonah", "Léa", "Omar", "Hana", "Gabriel", "Zoe", "Arjun", "Camille", "Malik",
  "Ana", "Hugo", "Mei", "Rafael", "Aisha", "Louis", "Nina", "Tariq", "Emma", "Diego", "Sana", "Olivier",
];

const usedResidentNames = new Set<string>();

/** A name nobody else has yet (numbered once the list runs out). */
function takeResidentName(random: () => number): string {
  const free = RESIDENT_NAMES.filter((n) => !usedResidentNames.has(n));
  const name = free.length > 0 ? npcPick(free, random) : `${npcPick(RESIDENT_NAMES, random)} ${usedResidentNames.size + 1}`;
  usedResidentNames.add(name);
  return name;
}

/** A day's plan: when to leave home, where to go, and when to head back. */
function makeRoutine(places: RoutinePlace[], random: () => number): RoutineStop[] {
  const at = (hour: number, spreadMinutes: number) => Math.round(hour * 60 + random() * spreadMinutes);
  const place = () => npcPick(places, random);
  const stops: RoutineStop[] = [
    { at: at(6.5, 150), activity: "visit", place: place() }, // morning: class or work
    { at: at(11.5, 75), activity: "visit", place: place() }, // lunch
    { at: at(14, 90), activity: random() < 0.5 ? "stroll" : "visit", place: place() }, // afternoon
    { at: at(17, 120), activity: "visit", place: place() }, // after class or work
  ];
  // Some are night owls who stroll around before heading home.
  if (random() < 0.3) stops.push({ at: at(19.5, 60), activity: "stroll" });
  stops.push({ at: at(20.5, 150), activity: "home" });
  return stops.sort((a, b) => a.at - b.at);
}

class Resident implements Walker {
  readonly name: string;
  readonly npc: Npc;
  readonly home: number;
  readonly routine: RoutineStop[];
  /** What they're up to, in words (shown on hover). */
  status = "At home";

  private readonly graph: WalkGraph;
  private readonly random: () => number;
  private mode: "home" | "travelling" | "at-place" | "strolling" = "home";
  /** Node they're at, or last left from. */
  private node: number;
  private stopIndex = -1;
  private day = -1;
  private targetOpacity = 0;
  private walkToken = 0;
  /** Seconds until they wander a few steps (at a place) or set off again (strolling). */
  private restIn = 0;

  constructor(npc: Npc, graph: WalkGraph, places: RoutinePlace[], random: () => number = Math.random) {
    this.npc = npc;
    this.graph = graph;
    this.random = random;
    this.name = takeResidentName(random);
    this.home = graph.randomNode(random);
    this.routine = makeRoutine(places, random);
    this.node = this.home;
    this.moveTo(this.home);
    npc.opacity = 0;
  }

  /** Puts them wherever their routine says they'd be at this time (used when the page opens). */
  placeAt(clock: GameClock): void {
    this.day = clock.day;
    this.stopIndex = this.currentStopIndex(clock.minutes);
    const stop = this.routine[this.stopIndex];
    if (!stop || stop.activity === "home") {
      this.goInside();
      return;
    }
    this.node = stop.activity === "visit" && stop.place ? stop.place.node : this.graph.randomNode(this.random);
    this.moveTo(this.node);
    this.npc.opacity = this.targetOpacity = 1;
    if (stop.activity === "visit" && stop.place) this.arriveAt(stop.place);
    else this.startStrolling();
  }

  update(dt: number, clock: GameClock): void {
    if (clock.day !== this.day) {
      // A new day: everyone starts it at home.
      this.day = clock.day;
      this.stopIndex = -1;
      if (this.mode !== "home") this.goInside();
    }

    const index = this.currentStopIndex(clock.minutes);
    if (index > this.stopIndex) {
      this.stopIndex = index;
      const stop = this.routine[index];
      if (stop) this.begin(stop);
    }

    if (this.npc.state === "idle" && (this.mode === "at-place" || this.mode === "strolling")) {
      this.restIn -= dt;
      if (this.restIn <= 0) {
        if (this.mode === "strolling") this.startStrolling();
        else this.millAround();
      }
    }

    // Fade in when stepping out, out when going inside.
    const fade = dt * 1.5;
    this.npc.opacity += Math.max(-fade, Math.min(fade, this.targetOpacity - this.npc.opacity));
    this.npc.update(dt);
  }

  private currentStopIndex(minutes: number): number {
    let index = -1;
    this.routine.forEach((stop, i) => {
      if (stop.at <= minutes) index = i;
    });
    return index;
  }

  private begin(stop: RoutineStop): void {
    if (stop.activity === "home") {
      if (this.mode !== "home") this.travel(this.home, "Heading home", () => this.goInside());
      return;
    }
    this.stepOutside();
    if (stop.activity === "visit" && stop.place) {
      const place = stop.place;
      this.travel(place.node, `Heading to ${place.name}`, () => this.arriveAt(place));
    } else {
      this.startStrolling();
    }
  }

  private stepOutside(): void {
    if (this.mode !== "home") return;
    this.node = this.home;
    this.moveTo(this.home);
    this.targetOpacity = 1;
  }

  private goInside(): void {
    this.walkToken++;
    this.npc.stop();
    this.mode = "home";
    this.status = "At home";
    this.node = this.home;
    this.targetOpacity = 0;
    if (this.npc.opacity === 0) this.moveTo(this.home);
  }

  private arriveAt(place: RoutinePlace): void {
    this.mode = "at-place";
    this.status = `At ${place.name}`;
    this.node = place.node;
    this.restIn = 4 + this.random() * 10;
    this.npc.face("down");
  }

  /** Walk along the walkways to `target`, then call onArrive. */
  private travel(target: number, status: string, onArrive: () => void): void {
    this.mode = "travelling";
    this.status = status;
    const from = this.graph.nearest(this.npc.x, this.npc.y);
    const route = this.graph.routePoints(from, target) ?? [this.graph.point(target)];
    this.walk([this.graph.point(from), ...route], target, onArrive);
  }

  /** Amble around the block, pause, and amble on. */
  private startStrolling(): void {
    this.mode = "strolling";
    this.status = "Out for a stroll";
    const from = this.graph.nearest(this.npc.x, this.npc.y);
    const nodes = this.graph.stroll(from, 8 + Math.floor(this.random() * 25), this.random);
    const end = nodes[nodes.length - 1]!;
    this.walk(nodes.map((n) => this.graph.point(n)), end, () => {
      this.restIn = 1 + this.random() * 5;
    });
  }

  /** While at a place: wander a few steps away and come back. */
  private millAround(): void {
    const out = this.graph.stroll(this.node, 1 + Math.floor(this.random() * 3), this.random);
    const back = out.slice(0, -1).reverse();
    const home = this.node;
    this.walk([...out.slice(1), ...back].map((n) => this.graph.point(n)), home, () => {
      this.restIn = 5 + this.random() * 12;
    });
  }

  private walk(points: WalkPoint[], end: number, onArrive: () => void): void {
    const token = ++this.walkToken;
    void this.npc.followPath(points).then((arrived) => {
      if (token !== this.walkToken) return; // replaced by a newer plan
      this.node = end;
      if (arrived) onArrive();
    });
  }

  private moveTo(node: number): void {
    const p = this.graph.point(node);
    this.npc.x = p.x;
    this.npc.y = p.y;
  }
}
