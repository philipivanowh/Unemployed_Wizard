// Walkable paths (from /api/walkways, OpenStreetMap data) as a graph in map pixel
// space, with shortest routes between any two points. Loaded as a plain script.

interface WalkwayGraphData {
  nodes: [number, number][];
  edges: [number, number][];
}

interface WalkPoint {
  x: number;
  y: number;
}

/** Min-heap of [priority, value] for the route search. */
class WalkHeap {
  private items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: number): void {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]![0] <= items[i]![0]) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (!top || !last) return undefined;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l]![0] < items[m]![0]) m = l;
        if (r < items.length && items[r]![0] < items[m]![0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top[1];
  }
}

class WalkGraph {
  readonly points: WalkPoint[];
  readonly neighbors: number[][];
  /** Spatial buckets for quick nearest-node lookups. */
  private readonly buckets = new Map<string, number[]>();
  private readonly bucketSize = 48;

  constructor(points: WalkPoint[], neighbors: number[][]) {
    this.points = points;
    this.neighbors = neighbors;
    points.forEach((p, i) => {
      const key = this.bucketKey(Math.floor(p.x / this.bucketSize), Math.floor(p.y / this.bucketSize));
      const list = this.buckets.get(key);
      if (list) list.push(i);
      else this.buckets.set(key, [i]);
    });
  }

  /**
   * Builds the graph from walkway data, keeping only paths inside the area and only
   * the largest connected network (so nobody gets stuck on a detached path).
   */
  static fromData(
    data: WalkwayGraphData,
    project: (lat: number, lng: number) => WalkPoint,
    keep: (lat: number, lng: number) => boolean,
  ): WalkGraph | null {
    const kept = data.nodes.map(([lat, lng]) => keep(lat, lng));
    const adjacency = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      const list = adjacency.get(a);
      if (list) list.push(b);
      else adjacency.set(a, [b]);
    };
    for (const [a, b] of data.edges) {
      if (kept[a] && kept[b]) {
        link(a, b);
        link(b, a);
      }
    }

    // Largest connected network.
    let best: number[] = [];
    const seen = new Set<number>();
    for (const start of adjacency.keys()) {
      if (seen.has(start)) continue;
      const component: number[] = [];
      const queue = [start];
      seen.add(start);
      while (queue.length > 0) {
        const n = queue.pop()!;
        component.push(n);
        for (const m of adjacency.get(n) ?? []) {
          if (!seen.has(m)) {
            seen.add(m);
            queue.push(m);
          }
        }
      }
      if (component.length > best.length) best = component;
    }
    if (best.length < 2) return null;

    const newIndex = new Map(best.map((old, i) => [old, i]));
    const points = best.map((old) => {
      const [lat, lng] = data.nodes[old]!;
      return project(lat, lng);
    });
    const neighbors = best.map((old) => (adjacency.get(old) ?? []).map((m) => newIndex.get(m)!));
    return new WalkGraph(points, neighbors);
  }

  /** A fallback "network" of straight lines between every pair of points. */
  static fromPoints(points: WalkPoint[]): WalkGraph {
    return new WalkGraph(
      points,
      points.map((_, i) => points.map((__, j) => j).filter((j) => j !== i)),
    );
  }

  get size(): number {
    return this.points.length;
  }

  point(node: number): WalkPoint {
    return this.points[node]!;
  }

  /** The node closest to (x, y). */
  nearest(x: number, y: number): number {
    const bx = Math.floor(x / this.bucketSize);
    const by = Math.floor(y / this.bucketSize);
    let best = -1;
    let bestDist = Infinity;
    // Search growing rings of buckets; once something's found, one more ring is enough.
    for (let ring = 0; ring < 200; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of this.buckets.get(this.bucketKey(bx + dx, by + dy)) ?? []) {
            const p = this.points[i]!;
            const d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          }
        }
      }
      if (best >= 0 && ring * this.bucketSize > Math.sqrt(bestDist)) break;
    }
    if (best < 0) {
      // Far outside every bucket: fall back to checking everything.
      this.points.forEach((p, i) => {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
    }
    return best;
  }

  /** Shortest route (A*) as a list of nodes, or null if there's no way through. */
  route(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const goal = this.points[to]!;
    const h = (n: number) => {
      const p = this.points[n]!;
      return Math.hypot(p.x - goal.x, p.y - goal.y);
    };
    const cost = new Map<number, number>([[from, 0]]);
    const cameFrom = new Map<number, number>();
    const open = new WalkHeap();
    open.push(h(from), from);
    const closed = new Set<number>();

    while (open.size > 0) {
      const current = open.pop()!;
      if (current === to) {
        const path = [to];
        let n = to;
        while (cameFrom.has(n)) {
          n = cameFrom.get(n)!;
          path.push(n);
        }
        return path.reverse();
      }
      if (closed.has(current)) continue;
      closed.add(current);
      const base = cost.get(current)!;
      const p = this.points[current]!;
      for (const next of this.neighbors[current]!) {
        if (closed.has(next)) continue;
        const q = this.points[next]!;
        const c = base + Math.hypot(q.x - p.x, q.y - p.y);
        if (c < (cost.get(next) ?? Infinity)) {
          cost.set(next, c);
          cameFrom.set(next, current);
          open.push(c + h(next), next);
        }
      }
    }
    return null;
  }

  /** Route as points to walk through. */
  routePoints(from: number, to: number): WalkPoint[] | null {
    const nodes = this.route(from, to);
    return nodes ? nodes.slice(1).map((n) => this.point(n)) : null;
  }

  randomNode(random: () => number = Math.random): number {
    return Math.floor(random() * this.points.length);
  }

  /**
   * A stroll: keep walking from node to node for `steps` hops, preferring not to
   * turn straight back, like someone ambling around the block.
   */
  stroll(start: number, steps: number, random: () => number = Math.random): number[] {
    const path = [start];
    let previous = -1;
    let current = start;
    for (let i = 0; i < steps; i++) {
      const options = this.neighbors[current]!;
      if (options.length === 0) break;
      const forward = options.filter((n) => n !== previous);
      const next = (forward.length > 0 ? forward : options)[Math.floor(random() * (forward.length || options.length))]!;
      previous = current;
      current = next;
      path.push(current);
    }
    return path;
  }

  private bucketKey(bx: number, by: number): string {
    return `${bx},${by}`;
  }
}
