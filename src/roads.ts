import { readFileSync } from 'node:fs';

/**
 * Real-road routing for ground pursuits.
 *
 * scripts/prebake-roads.mjs harvests a junction GRAPH per anchor from
 * OpenStreetMap: vertices are real intersections, edges are the road between
 * two of them with the way's actual geometry. Driving a pursuit is then a walk
 * over that graph — at each intersection pick an exit that isn't the one you
 * arrived on — which is what makes a fleeing vehicle follow an actual road and
 * take an actual turn instead of cutting across a paddock.
 *
 * roads.json is optional. If it is missing (or an anchor isn't in it) the
 * caller falls back to a synthetic route, so tasking never breaks on a bad
 * data file.
 */

/** [lat, lon] */
type V = [number, number];
type Edge = {
  a: number;
  b: number;
  /** 0 motorway · 1 trunk · 2 primary · 3 secondary */
  c: number;
  /** road name or route number, when OSM has one */
  n: string | null;
  g: V[];
  /** length in metres */
  m: number;
};
type Graph = { v: V[]; e: Edge[] };

let GRAPHS: Record<string, Graph> = {};
try {
  GRAPHS = JSON.parse(readFileSync(new URL('./roads.json', import.meta.url), 'utf8')) as Record<string, Graph>;
} catch {
  GRAPHS = {}; // not harvested yet — pursuits use a synthetic route
}

/** Adjacency, built once per anchor on first use. */
const ADJ = new Map<string, Map<number, number[]>>();
function adjacency(name: string, g: Graph): Map<number, number[]> {
  let a = ADJ.get(name);
  if (a) return a;
  a = new Map();
  g.e.forEach((edge, i) => {
    for (const v of [edge.a, edge.b]) {
      const list = a!.get(v);
      if (list) list.push(i);
      else a!.set(v, [i]);
    }
  });
  ADJ.set(name, a);
  return a;
}

export function hasRoadGraph(anchorName: string): boolean {
  const g = GRAPHS[anchorName];
  return Boolean(g && g.e.length > 8);
}

const NM_PER_DEG = 60;
function nm(a: V, b: V): number {
  const dLat = (b[0] - a[0]) * NM_PER_DEG;
  const dLon = (b[1] - a[1]) * NM_PER_DEG * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
function bearing(a: V, b: V): number {
  const dLat = (b[0] - a[0]) * NM_PER_DEG;
  const dLon = (b[1] - a[1]) * NM_PER_DEG * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return (Math.atan2(dLon, dLat) * 180) / Math.PI;
}
/** Smallest signed angle between two bearings. */
function turn(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180);
}

export type PursuitPoint = { lat: number; lon: number; speedKt: number };
export type PursuitRoute = {
  points: PursuitPoint[];
  /** road names along the way, in order, deduped — for the tasking brief */
  roads: string[];
  /** total ground distance, NM */
  distanceNm: number;
  /** where the pursuit terminates and the offenders bail out */
  end: { lat: number; lon: number };
};

/**
 * How fast a fleeing vehicle runs on each road class, in km/h. A pursuit on a
 * motorway is genuinely fast; through a suburban secondary it is not, and a
 * helicopter that can't keep up with a car on a back street would be absurd.
 */
const SPEED_KMH: Record<number, [number, number]> = {
  0: [120, 165],
  1: [95, 135],
  2: [75, 115],
  3: [60, 95],
};
const KT = 1.852;

/** A vehicle type sets a ceiling — a stolen truck does not do 160. */
export type FleeProfile = 'car' | 'bike' | 'truck';
const CEILING_KMH: Record<FleeProfile, number> = { car: 165, bike: 180, truck: 100 };

/**
 * Typical speed per road class, km/h — used to budget the walk by TIME.
 * Distance is the wrong budget: 13 NM of 60 km/h secondary road is a
 * twenty-minute orbit, while the same distance of motorway is eight.
 */
const SPEED_MID: Record<number, number> = { 0: 142, 1: 115, 2: 95, 3: 77 };

type WalkOpts = {
  /** aim for roughly this many MINUTES of driving */
  targetMin?: number;
  profile?: FleeProfile;
  /** start within this many NM of here, if possible */
  near?: { lat: number; lon: number } | null;
  rand?: () => number;
};

/**
 * Walk the graph to build one pursuit. Returns null when the anchor has no
 * usable road data, so the caller can fall back.
 */
export function pursuitRoute(anchorName: string, opts: WalkOpts = {}): PursuitRoute | null {
  const g = GRAPHS[anchorName];
  if (!g || g.e.length < 8) return null;
  const rnd = opts.rand ?? Math.random;
  const targetMin = opts.targetMin ?? 6 + rnd() * 6;
  const profile = opts.profile ?? 'car';
  const adj = adjacency(anchorName, g);

  // Try a few starts and keep the best — a walk that dead-ends after 300 m is
  // not a pursuit, and some harvested components are small.
  let best: { seq: { edge: Edge; fwd: boolean }[]; dist: number; mins: number } | null = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const start = pickStart(g, adj, opts.near, rnd);
    if (start == null) break;
    const walk = walkFrom(g, adj, start, targetMin, rnd);
    if (!best || walk.mins > best.mins) best = walk;
    if (best.mins >= targetMin * 0.75) break;
  }
  if (!best || best.dist < 1.5) return null;

  // Stitch the geometry, dropping the duplicated junction point between edges.
  const points: PursuitPoint[] = [];
  const roads: string[] = [];
  const ceiling = CEILING_KMH[profile];
  for (const { edge, fwd } of best.seq) {
    const geo = fwd ? edge.g : [...edge.g].reverse();
    const [lo, hi] = SPEED_KMH[edge.c] ?? SPEED_KMH[3]!;
    const kmh = Math.min(ceiling, lo + rnd() * (hi - lo));
    const speedKt = Math.round((kmh / KT) * 10) / 10;
    for (let i = points.length ? 1 : 0; i < geo.length; i++) {
      points.push({ lat: geo[i]![0], lon: geo[i]![1], speedKt });
    }
    if (edge.n && roads[roads.length - 1] !== edge.n) roads.push(edge.n);
  }
  if (points.length < 3) return null;

  // The bail-out: the last ~400 m is a hard deceleration to a stop, so the
  // vehicle ends stationary and the crew can watch the offenders run.
  decelerate(points);

  const end = points[points.length - 1]!;
  return {
    points,
    roads: roads.slice(0, 6),
    distanceNm: Math.round(best.dist * 10) / 10,
    end: { lat: end.lat, lon: end.lon },
  };
}

/** Choose an edge to set off from, preferring one near `near` with a junction at each end. */
function pickStart(
  g: Graph,
  adj: Map<number, number[]>,
  near: { lat: number; lon: number } | null | undefined,
  rnd: () => number,
): { edgeIdx: number; fwd: boolean } | null {
  const usable = (i: number) => (adj.get(g.e[i]!.b)?.length ?? 0) > 1 || (adj.get(g.e[i]!.a)?.length ?? 0) > 1;
  let pool: number[] = [];
  if (near) {
    const p: V = [near.lat, near.lon];
    pool = g.e
      .map((e, i) => ({ i, d: nm(p, e.g[0]!) }))
      .filter((x) => x.d <= 22 && usable(x.i))
      .sort((a, b) => a.d - b.d)
      .slice(0, 90)
      .map((x) => x.i);
  }
  if (!pool.length) pool = g.e.map((_, i) => i).filter(usable);
  if (!pool.length) return null;
  const edgeIdx = pool[Math.floor(rnd() * pool.length)]!;
  // Set off toward an end that actually continues somewhere. Picking at random
  // when only one end is a junction sends half of all pursuits straight into a
  // dead end after a single edge.
  const bOk = (adj.get(g.e[edgeIdx]!.b)?.length ?? 0) > 1;
  const aOk = (adj.get(g.e[edgeIdx]!.a)?.length ?? 0) > 1;
  const fwd = bOk && aOk ? rnd() < 0.5 : bOk;
  return { edgeIdx, fwd };
}

/**
 * Drive the graph from `start` until we've covered `targetNm` or run out of
 * road. At each junction prefer carrying straight on — a pursuit mostly runs,
 * it doesn't take every turn — but take a real turn often enough that the
 * track isn't a straight line.
 */
function walkFrom(
  g: Graph,
  adj: Map<number, number[]>,
  start: { edgeIdx: number; fwd: boolean },
  targetMin: number,
  rnd: () => number,
): { seq: { edge: Edge; fwd: boolean }[]; dist: number; mins: number } {
  const seq: { edge: Edge; fwd: boolean }[] = [];
  const used = new Set<number>();
  let edgeIdx = start.edgeIdx;
  let fwd = start.fwd;
  let dist = 0;
  let mins = 0;

  for (let step = 0; step < 400; step++) {
    const edge = g.e[edgeIdx]!;
    seq.push({ edge, fwd });
    used.add(edgeIdx);
    dist += edge.m / 1852;
    mins += (edge.m / 1000 / (SPEED_MID[edge.c] ?? 77)) * 60;
    if (mins >= targetMin) break;

    const at = fwd ? edge.b : edge.a;
    const geo = fwd ? edge.g : [...edge.g].reverse();
    const inBrg = bearing(geo[geo.length - 2]!, geo[geo.length - 1]!);

    const exits = (adj.get(at) ?? []).filter((i) => i !== edgeIdx && !used.has(i));
    if (!exits.length) break;

    // Score each exit: straight-on is cheap, a U-turn is nearly impossible, and
    // a bigger road is a slightly more attractive run.
    const scored = exits.map((i) => {
      const e = g.e[i]!;
      const f = e.a === at;
      const og = f ? e.g : [...e.g].reverse();
      const outBrg = bearing(og[0]!, og[1]!);
      const t = turn(inBrg, outBrg);
      return { i, fwd: f, score: t + (t > 150 ? 400 : 0) - (3 - e.c) * 12 + rnd() * 95 };
    });
    scored.sort((a, b) => a.score - b.score);
    const next = scored[0]!;
    edgeIdx = next.i;
    fwd = next.fwd;
  }
  return { seq, dist, mins };
}

/** Ramp the tail of the route down to a stop over the last ~400 m. */
function decelerate(points: PursuitPoint[]): void {
  let run = 0;
  for (let i = points.length - 1; i > 0; i--) {
    run += nm([points[i]!.lat, points[i]!.lon], [points[i - 1]!.lat, points[i - 1]!.lon]) * 1852;
    const f = Math.min(1, run / 400);
    points[i]!.speedKt = Math.round(points[i]!.speedKt * f * 10) / 10;
    if (run >= 400) break;
  }
  points[points.length - 1]!.speedKt = 0;
}

/**
 * No road graph for this anchor — build a plausible route anyway so the job
 * still runs. Straight runs with occasional turns, which reads acceptably from
 * 1000 ft even though it isn't on a real road.
 */
export function syntheticRoute(
  from: { lat: number; lon: number },
  opts: {
    targetNm?: number;
    profile?: FleeProfile;
    rand?: () => number;
    /** set off on this heading rather than a random one */
    bearing?: number;
    /** cap each course change (deg) — a vessel tracking a coast turns gently */
    turnMax?: number;
    /** speed band override, km/h — a boat is not a car */
    speedKmh?: [number, number];
  } = {},
): PursuitRoute {
  const rnd = opts.rand ?? Math.random;
  const targetNm = opts.targetNm ?? 8 + rnd() * 7;
  const ceiling = opts.speedKmh ? opts.speedKmh[1] : CEILING_KMH[opts.profile ?? 'car'];
  const [sLo, sHi] = opts.speedKmh ?? [70, 140];
  const turnMax = opts.turnMax ?? 90;
  const points: PursuitPoint[] = [{ lat: from.lat, lon: from.lon, speedKt: 0 }];
  let brg = opts.bearing ?? rnd() * 360;
  let dist = 0;
  let lat = from.lat;
  let lon = from.lon;
  while (dist < targetNm) {
    const leg = 0.6 + rnd() * 2.2;
    const kmh = Math.min(ceiling, sLo + rnd() * (sHi - sLo));
    const speedKt = Math.round((kmh / KT) * 10) / 10;
    // a few intermediate points so the turn onto the new heading is not instant
    const steps = Math.max(2, Math.round(leg * 3));
    for (let s = 1; s <= steps; s++) {
      const d = (leg / steps) * s;
      const br = (brg * Math.PI) / 180;
      const la = lat + (d * Math.cos(br)) / NM_PER_DEG;
      const lo = lon + (d * Math.sin(br)) / (NM_PER_DEG * Math.cos((lat * Math.PI) / 180));
      points.push({ lat: la, lon: lo, speedKt });
      if (s === steps) {
        lat = la;
        lon = lo;
      }
    }
    dist += leg;
    brg = (brg + (rnd() < 0.5 ? -1 : 1) * (turnMax * (0.3 + rnd() * 0.7)) + 360) % 360;
  }
  points[0]!.speedKt = points[1]?.speedKt ?? 60;
  decelerate(points);
  const end = points[points.length - 1]!;
  return { points, roads: [], distanceNm: Math.round(dist * 10) / 10, end: { lat: end.lat, lon: end.lon } };
}
