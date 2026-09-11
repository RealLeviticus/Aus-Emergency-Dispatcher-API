/**
 * Pre-bake a DRIVABLE ROAD GRAPH per anchor town, so a police pursuit follows
 * real Australian roads and takes real intersections.
 *
 * prebake-features.mjs stores one centre POINT per road way — enough to drop an
 * MVA on a road, useless for driving along one. This harvests full way geometry
 * (`out geom`), then splits every way at the nodes it SHARES with another way.
 * Those shared nodes are junctions, so the result is a graph:
 *
 *   v: [[lat, lon], ...]                          junction / dead-end vertices
 *   e: [{ a, b, c, n, g: [[lat, lon], ...], m }]  edges between them
 *
 * A pursuit is then a walk over `e`: at each vertex pick an outgoing edge that
 * isn't the one you arrived on, and concatenate its geometry.
 *
 * Writes src/roads.json, which jobgen.ts loads at startup (and tolerates being
 * absent — pursuits fall back to a synthetic route). Re-run only when ANCHORS
 * changes:
 *
 *   node scripts/prebake-roads.mjs src/roads.json
 *
 * Overpass is rate-limited and this pulls real geometry, so it takes 15+
 * minutes. It is an offline build step — the server never calls Overpass.
 *
 * NOTE: node's fetch cannot reach the Overpass mirrors from some networks
 * (UND_ERR_CONNECT_TIMEOUT) while curl to the same URL succeeds, so this shells
 * out to curl. The cache is written after EVERY anchor and completed anchors
 * are skipped on restart — these runs stall often enough that an
 * all-at-the-end write loses the lot.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';

const OUT = process.argv[2] ?? 'src/roads.json';

const src = readFileSync('src/jobgen.ts', 'utf8');
const LOC = [
  ...src
    .match(/const ANCHORS[\s\S]*?\n\];/)[0]
    .matchAll(/name: '([^']+)', region: '([A-Z]+)', lat: (-?[\d.]+), lon: (-?[\d.]+), kind: '(\w+)'/g),
].map((m) => ({ name: m[1], region: m[2], lat: +m[3], lon: +m[4], kind: m[5] }));
console.log(`${LOC.length} locations`);

// maps.mail.ru is the full-planet mirror that answers reliably from here;
// overpass-api.de is the fallback. NEVER add overpass.osm.ch — it is a
// Switzerland-only extract that answers Australian queries with HTTP 200 and
// zero elements, i.e. a silent empty dataset rather than an error.
const EPS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function ask(query, attempts = 6) {
  for (let a = 0; a < attempts; a++) {
    const ep = EPS[a % EPS.length];
    const r = spawnSync(
      'curl',
      [
        '-s',
        '-m',
        '300',
        '-X',
        'POST',
        ep,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-H',
        'User-Agent: AED-road-prebake/1.0',
        '--data-urlencode',
        `data=${query}`,
      ],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
    );
    const t = r.stdout ?? '';
    if (t.trimStart().startsWith('{')) {
      try {
        return JSON.parse(t);
      } catch {
        /* truncated response — retry */
      }
    }
    sleep(5000 + a * 5000);
  }
  return null;
}

// --- geometry helpers ----------------------------------------------------

const R5 = (n) => Math.round(n * 100000) / 100000;
const NM_PER_DEG = 60;

function metres(a, b) {
  const dLat = (b[0] - a[0]) * NM_PER_DEG;
  const dLon = (b[1] - a[1]) * NM_PER_DEG * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon) * 1852;
}

/** Drop intermediate points closer than `tol` metres — keeps corners, kills detail. */
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (metres(out[out.length - 1], pts[i]) >= tol) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

function length(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1], pts[i]);
  return m;
}

const CLASS = { motorway: 0, motorway_link: 0, trunk: 1, primary: 2, secondary: 3 };
// A metro anchor sits in a dense arterial network. Ways are split at every
// shared node, so a city intersects its own arterials constantly: 20 km of
// Melbourne primary alone is 16k edges. 14 km is still 7.5 NM of city in every
// direction — far more road than any one pursuit uses — and keeps the file
// sane.
const RADIUS = (kind) => (kind === 'metro' ? 14000 : 30000);
const CLASSES = (kind) =>
  kind === 'metro' ? 'motorway|motorway_link|trunk|primary' : 'motorway|motorway_link|trunk|primary|secondary';
const MAX_EDGES = 2500;

/** Build the junction graph for one anchor from its Overpass ways. */
function graph(ways) {
  // A node shared by two or more ways is a junction. Way endpoints are kept too
  // so the walk has somewhere to terminate instead of running off the data.
  const seen = new Map();
  for (const w of ways) for (const id of w.nodes) seen.set(id, (seen.get(id) ?? 0) + 1);

  const vIndex = new Map(); // osm node id -> vertex index
  const v = [];
  const vertex = (id, pt) => {
    let i = vIndex.get(id);
    if (i == null) {
      i = v.length;
      vIndex.set(id, i);
      v.push([R5(pt[0]), R5(pt[1])]);
    }
    return i;
  };

  const e = [];
  for (const w of ways) {
    const cls = CLASS[w.tags?.highway];
    if (cls == null || !w.geometry || w.geometry.length < 2 || w.geometry.length !== w.nodes.length) continue;
    const pts = w.geometry.map((p) => [p.lat, p.lon]);
    const name = w.tags?.name ?? w.tags?.ref ?? null;
    // Walk the way, cutting a new edge at every junction node (and at the ends).
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const isEnd = i === pts.length - 1;
      if (!isEnd && (seen.get(w.nodes[i]) ?? 0) < 2) continue;
      const seg = pts.slice(start, i + 1);
      const a = vertex(w.nodes[start], seg[0]);
      const b = vertex(w.nodes[i], seg[seg.length - 1]);
      start = i;
      if (a === b) continue; // a loop back onto the same junction
      const g = simplify(seg, 40).map((p) => [R5(p[0]), R5(p[1])]);
      if (g.length < 2) continue;
      e.push({ a, b, c: cls, n: name, g, m: Math.round(length(seg)) });
    }
  }
  return { v, e };
}

/**
 * Cut the graph down to what a pursuit actually needs:
 *
 *  1. keep only the LARGEST CONNECTED COMPONENT — an isolated pocket of road is
 *     a walk that dead-ends after 300 m, which is not a pursuit;
 *  2. then apply the edge budget, taking the biggest roads first and the
 *     longest within a class, so what survives is the arterial skeleton rather
 *     than a random scatter.
 */
function trim({ v, e }) {
  // union-find over the vertices
  const parent = v.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const x of e) {
    const ra = find(x.a);
    const rb = find(x.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const size = new Map();
  for (const x of e) {
    const r = find(x.a);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  let bigRoot = null;
  let bigN = 0;
  for (const [r, n] of size) if (n > bigN) ((bigN = n), (bigRoot = r));
  let kept = bigRoot == null ? e : e.filter((x) => find(x.a) === bigRoot);

  if (kept.length > MAX_EDGES) {
    kept = [...kept].sort((p, q) => p.c - q.c || q.m - p.m).slice(0, MAX_EDGES);
  }

  // Re-index the vertices the surviving edges actually use.
  const used = new Map();
  const v2 = [];
  for (const x of kept) {
    for (const k of ['a', 'b']) {
      let i = used.get(x[k]);
      if (i == null) {
        i = v2.length;
        used.set(x[k], i);
        v2.push(v[x[k]]);
      }
      x[k] = i;
    }
  }
  return { v: v2, e: kept };
}

// --- harvest -------------------------------------------------------------

const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
let done = 0;
for (const L of LOC) {
  if (out[L.name]?.e?.length) {
    done++;
    console.log(`   skip (cached)   ${L.name}`);
    continue;
  }
  const q = `[out:json][timeout:280];way(around:${RADIUS(L.kind)},${L.lat},${L.lon})["highway"~"^(${CLASSES(L.kind)})$"]["access"!~"^(private|no)$"];out geom;`;
  const j = ask(q);
  if (!j) {
    console.log(`?? FAILED         ${L.name}`);
    sleep(3000);
    continue;
  }
  const ways = j.elements.filter((x) => x.type === 'way' && x.geometry && x.nodes);
  const { v, e } = trim(graph(ways));
  out[L.name] = { v, e };
  writeFileSync(OUT, JSON.stringify(out));
  done++;
  console.log(
    `${String(e.length).padStart(5)} edges ${String(v.length).padStart(5)} nodes  ${L.name}  (${done}/${LOC.length})`,
  );
  sleep(2500);
}
console.log(`DONE — ${Object.keys(out).length} anchors, ${(readFileSync(OUT).length / 1048576).toFixed(1)} MB`);
