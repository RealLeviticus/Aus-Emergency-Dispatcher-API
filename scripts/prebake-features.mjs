/**
 * Pre-bake real OpenStreetMap features per anchor town, so a job lands on the
 * thing its brief describes: a level crossing on an actual rail crossing, an MVA
 * on an actual road. Without this, placePoint() picks a random bearing from the
 * town centre and a "level crossing" ends up in a paddock — or offshore.
 *
 * Writes src/features.json, which jobgen.ts loads at startup (and tolerates
 * being absent). Re-run only when ANCHORS changes:
 *
 *   node scripts/prebake-features.mjs src/features.json
 *
 * Overpass is rate-limited, so this takes several minutes and retries across
 * mirrors. It is an offline build step — the server never calls Overpass.
 */
// Pre-bake real map features per location so scenes land on the thing the job
// describes: a level crossing on an actual railway crossing, an MVA on a real
// road. Run offline; the result ships with the API (no runtime Overpass call).
import { readFileSync, writeFileSync } from 'fs';
const src = readFileSync('src/jobgen.ts', 'utf8');
const LOC = [...src.match(/const ANCHORS[\s\S]*?\n\];/)[0]
  .matchAll(/name: '([^']+)', region: '([A-Z]+)', lat: (-?[\d.]+), lon: (-?[\d.]+)/g)]
  .map((m) => ({ name: m[1], region: m[2], lat: +m[3], lon: +m[4] }));
console.log(`${LOC.length} locations`);

const EPS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.osm.jp/api/interpreter'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ask(q) {
  for (let a = 0; a < 10; a++) {
    try {
      const r = await fetch(EPS[a % EPS.length], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AED-scene-prebake/1.0' },
        body: 'data=' + encodeURIComponent(q),
      });
      const t = await r.text();
      if (t.trimStart().startsWith('{')) return JSON.parse(t);
    } catch { /* retry */ }
    await sleep(4000 + a * 4000);
  }
  return null;
}
const round = (n) => Math.round(n * 100000) / 100000;
const out = {};
for (const L of LOC) {
  // level crossings, and points on real roads of a decent class
  const q = `[out:json][timeout:120];
    (node(around:45000,${L.lat},${L.lon})["railway"="level_crossing"];
     node(around:45000,${L.lat},${L.lon})["railway"="crossing"];);out ${''}skel 200;
    way(around:35000,${L.lat},${L.lon})["highway"~"^(motorway|trunk|primary|secondary)$"];out center 200;`;
  const j = await ask(q);
  if (!j) { console.log(`?? FAILED ${L.name}`); await sleep(2500); continue; }
  const xing = j.elements.filter((e) => e.type === 'node' && Number.isFinite(e.lat)).map((e) => [round(e.lat), round(e.lon)]);
  const roads = j.elements.filter((e) => e.type === 'way' && e.center).map((e) => [round(e.center.lat), round(e.center.lon)]);
  out[L.name] = { xing: xing.slice(0, 60), road: roads.slice(0, 60) };
  console.log(`${String(xing.length).padStart(4)} crossings ${String(roads.length).padStart(4)} roads   ${L.name}`);
  await sleep(2500);
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('DONE');
