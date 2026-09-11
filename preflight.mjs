/**
 * Pre-release invariants for generated tasking. Every one of these has been a
 * real bug at some point, so they are asserted rather than eyeballed.
 */
import { generateJob } from './dist/jobgen.js';
import { readFileSync } from 'fs';

const H = new Map(JSON.parse(readFileSync('./src/hospitals.json', 'utf8')).map((h) => [h.name, h]));
const F = JSON.parse(readFileSync('./src/features.json', 'utf8'));
const AIR = JSON.parse(readFileSync('./src/hospital-airports.json', 'utf8'));
const R = 6371000;
const m = (a, b, c, d) => {
  const p = Math.PI / 180, x = (c - a) * p, y = (d - b) * p;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const nm = (a, b, c, d) => m(a, b, c, d) / 1852;

const MAP = [[/level crossing|rail crossing|grain-line/i,'xing'],[/rail corridor|rail maintenance|railway/i,'rail'],[/highway|freeway|arterial|bypass|truck route|mountain pass|descent|interchange/i,'majorroad'],[/roadhouse/i,'roadhouse'],[/caravan park/i,'caravan'],[/industrial estate/i,'industrial'],[/town centre/i,'retail'],[/residential|suburban/i,'residential'],[/parkland|sports oval|showground/i,'park'],[/national park|state forest|forest|timbered|bushland|forestry|scrub/i,'forest'],[/reserve|ranges?\b|gullies|fire trail/i,'reserve'],[/catchment|reservoir|\bdam\b|\blake\b|weir/i,'water'],[/river|creek|causeway|swollen|floodwater|flood-/i,'river'],[/marina|jetty|boat ramp|slipway|dive charter/i,'marina'],[/beach|foreshore|sand/i,'beach'],[/cliff|rock platform|headland|bluff/i,'cliff'],[/construction site/i,'construction'],[/mine camp|quarry|\bmine\b/i,'quarry'],[/powerline|easement|transmission/i,'powerline'],[/pipeline/i,'pipeline'],[/grazing|cropping|paddock|farm|station|shearing|rural block|stubble|orchard|irrigator|homestead|outstation|bore run/i,'farmland']];
const TOUCHES = { NSW:['VIC','QLD','SA','ACT'], VIC:['NSW','SA'], QLD:['NSW','SA','NT'], SA:['WA','NT','QLD','NSW','VIC'], WA:['SA','NT'], NT:['WA','SA','QLD'], TAS:[], ACT:['NSW'] };
const STATE_WORDS = [[/New South Wales|\bNSW\b/i,'NSW'],[/Victoria\b|\bVIC\b|\bCFA\b|\bFRV\b/i,'VIC'],[/Queensland|\bQLD\b|\bRACQ\b/i,'QLD'],[/Western Australia|\bDBCA\b|\bDFES\b|\(WA\)/i,'WA'],[/South Australia|\bMedSTAR\b/i,'SA'],[/Tasmania|\bTAS\b/i,'TAS'],[/Northern Territory/i,'NT'],[/\bACT\b/i,'ACT']];

const fail = [];
const note = (msg) => fail.push(msg);
let n = 0, pinN = 0, pinOk = 0, fwN = 0, rotN = 0, branded = 0, outOfArea = 0;
const kinds = new Set();

for (let i = 0; i < 60000; i++) {
  const j = generateJob();
  n++;
  kinds.add(j.kind);

  // 1. a destination must exist as a real place
  if (j.transportTo) {
    if (j.aircraftClass === 'fixed') {
      fwN++;
      if (j.transportTo.pad) note(`fixed-wing sent to a helipad: ${j.transportTo.name}`);
      if (H.has(j.transportTo.name)) note(`fixed-wing sent to a hospital: ${j.transportTo.name}`);
    } else {
      rotN++;
      if (!H.has(j.transportTo.name)) note(`rotary sent somewhere that is not a hospital: ${j.transportTo.name}`);
    }
    // 2. far enough to be worth flying
    const floor = j.aircraftClass === 'fixed' ? 60 : 20;
    const d = nm(j.lat, j.lon, j.transportTo.lat, j.transportTo.lon);
    if (d < floor - 0.5) note(`${j.aircraftClass} transport only ${d.toFixed(1)} nm (floor ${floor}): ${j.kind}`);
  }

  // 3. offshore jobs are offshore
  const off = /^(\d+) NM off /.exec(j.place ?? '');
  if (off && +off[1] < 3) note(`offshore job only ${off[1]} NM out: ${j.place}`);

  // 4. a transfer must not depart and arrive at the same field
  const via = /via [^(]+\(([A-Z]{4})\)/.exec(j.place ?? '');
  if (via && j.transportTo?.name.includes(via[1])) note(`departs and arrives at ${via[1]}`);

  // 5. the pin is on the feature the text names
  const pm = /^(.*?)\s+near\s+([^,]+),/.exec(j.place ?? '');
  if (pm) {
    const kind = MAP.find(([re]) => re.test(pm[1]))?.[1];
    const list = kind && F[pm[2]]?.[kind];
    if (list?.length) {
      pinN++;
      let best = Infinity;
      for (const [la, lo] of list) best = Math.min(best, m(j.lat, j.lon, la, lo));
      if (best <= 250) pinOk++;
      else note(`pin ${Math.round(best)} m from the ${kind} it names: ${j.place}`);
    }
  }

  // 6. a state-branded agency is not working in a state it does not touch
  const hit = STATE_WORDS.find(([re]) => re.test(j.agency));
  if (hit) {
    branded++;
    if (hit[1] !== j.region && !(TOUCHES[j.region] ?? []).includes(hit[1])) {
      outOfArea++;
      note(`${j.agency} tasked in ${j.region}: ${j.place}`);
    }
  }

  // 7. every job has the fields the client renders
  for (const f of ['id', 'kind', 'category', 'agency', 'callsign', 'lat', 'lon', 'place', 'region', 'brief', 'detail', 'lz', 'units', 'priority', 'aircraftClass'])
    if (j[f] === undefined || j[f] === null || j[f] === '') note(`missing field "${f}" on ${j.kind}`);
  if (!Number.isFinite(j.lat) || !Number.isFinite(j.lon) || j.lat > -8 || j.lat < -45 || j.lon < 110 || j.lon > 156)
    note(`coordinates outside Australia: ${j.lat},${j.lon} (${j.kind})`);
}

const uniq = [...new Set(fail)];
console.log(`${n} jobs, ${kinds.size} distinct kinds`);
console.log(`  pins on the named feature : ${pinOk}/${pinN} (${((pinOk / pinN) * 100).toFixed(1)}%)`);
console.log(`  fixed-wing w/ destination : ${fwN}   rotary: ${rotN}`);
console.log(`  state-branded taskings    : ${branded}, out of area ${outOfArea}`);
console.log(`  hospitals with an airport : ${Object.keys(AIR).length}`);
console.log(uniq.length ? `\nFAILURES (${uniq.length} distinct, ${fail.length} total):` : '\nall invariants hold');
uniq.slice(0, 12).forEach((f) => console.log('   ', f));
process.exit(uniq.length ? 1 : 0);
