import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hasRoadGraph, pursuitRoute, syntheticRoute, type FleeProfile } from './roads.js';
import { AAR_ANCHORS, REFUELLING_TRACKS, type RefuellingTrack, type Waypoint } from './airspace.js';
import {
  availabilityAt,
  HOME_BASES,
  launchableBases,
  RAAFV_BASES,
  rosterRoles,
  unitForAircraft,
  unitsFor,
  type Base as FleetBase,
  type Role,
} from './fleet.js';

/**
 * Server-side tasking generator. Jobs are placed at real Australian locations so
 * every connected operator sees the same pool before they load a sim, and can
 * claim one. Aircraft-relative bearing/distance are computed by each client
 * against its own position.
 */

export type Priority = 'P1' | 'P2' | 'P3';
export type AircraftClass = 'rotary' | 'fixed';
export type JobStatus = 'available' | 'claimed' | 'active' | 'complete';
export type JobPhase = 'enroute' | 'onscene' | 'transport' | 'athospital' | 'returning';
/** Which board a job belongs to: the public emergency pool or the RAAFv pool. */
export type Channel = 'emergency' | 'raafv';

export type Hospital = {
  name: string;
  lat: number;
  lon: number;
  /** helipad ident from the MSFS helipad package, when the sim has a pad there */
  pad?: string;
};

/** An AI aircraft the job wants spawned (via FSLTL) that flies a set route. */
export type AirTarget = {
  label: string;
  /** hint for the client's FSLTL title picker */
  titleHint: 'jet' | 'heavy' | 'prop' | 'light';
  /** repeat the route (racetrack / orbit) */
  loop?: boolean;
  /** spawn this many in trail (~2 NM apart) — a raid / formation */
  formation?: number;
  /** the target loiters at route[0] until the interceptor is within this range,
   *  so it can't fly past before you get airborne */
  holdUntilNm?: number;
  /** transponder code, for the brief */
  squawk?: string;
  route: { lat: number; lon: number; altFt: number; speedKt: number }[];
};

/**
 * A GROUND (or surface) vehicle the job wants spawned and driven — the car in a
 * police pursuit, a convoy being monitored, a vessel of interest. Unlike an
 * AirTarget these follow real roads: the route comes from the pre-baked OSM
 * road graph (see roads.ts), so the vehicle takes actual intersections.
 */
export type GroundTarget = {
  label: string;
  /** picks the title group the client spawns */
  vehicle: 'car' | 'bike' | 'truck' | 'boat';
  /**
   * `flee` runs hard and bails out at the end of the route — the crew watches
   * it stop and the offenders decamp. `cruise` just drives, unaware it is
   * being followed, which is the covert / monitoring tasking.
   */
  behaviour: 'flee' | 'cruise';
  /** holds at route[0] until the aircraft is within this range, so it cannot
   *  finish the run before you get airborne */
  holdUntilNm?: number;
  /** spawn this many in trail — a convoy, or a group of bikes */
  convoy?: number;
  /** registration / description, for the brief */
  rego?: string;
  /** the roads it runs along, in order — for the brief and the commentary */
  roads?: string[];
  route: { lat: number; lon: number; speedKt: number }[];
};

export type Job = {
  id: string;
  createdAt: number;
  status: JobStatus;
  /** the lead unit (first to claim) */
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: number | null;
  phase: JobPhase | null;
  /** everyone working this call — the lead plus anyone who has joined */
  party?: { clientId: string; name: string; joinedAt: number }[];

  aircraftClass: AircraftClass;
  priority: Priority;
  kind: string;
  category: string;
  agency: string;
  callsign: string;

  lat: number;
  lon: number;
  place: string;
  region: string;
  latLon: string;

  brief: string;
  detail: string;
  source: string;
  informant: string;
  hazards: string;
  persons: string;
  access: string;
  lz: string;
  units: string[];
  weather: string;
  transportTo?: Hospital;
  /** clinical one-liner for the patient, where relevant */
  patient?: string;
  /** short ETA / on-task window guidance */
  timeline?: string;

  /** which board this job is on (default 'emergency') */
  channel: Channel;
  /** RAAFv only: the AI aircraft to intercept / shadow / join on (may be a formation) */
  targets?: AirTarget[];
  /**
   * RAAFv only: the airframe the tasking is written for. `registration` is a
   * real tail number read from the crew centre fleet — present only when the
   * aircraft is genuinely parked at that base and not already flying.
   */
  tasked?: {
    type: string;
    squadron: string;
    registration?: string;
    /** where the sortie launches from — not necessarily the squadron's home */
    homeBase: string;
    /** the squadron is deployed there rather than based there */
    detachment?: boolean;
    source: 'crew-centre' | 'roster';
  };
  /** vehicles / vessels to spawn and drive — police pursuits and surveillance */
  groundTargets?: GroundTarget[];
};

// ---- rng --------------------------------------------------------------

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
const rint = (lo: number, hi: number) => Math.floor(lo + Math.random() * (hi - lo + 1));
const chance = (p: number) => Math.random() < p;

// ---- Australian anchor locations ------------------------------------

type Anchor = {
  name: string;
  region: string;
  lat: number;
  lon: number;
  kind: 'metro' | 'regional' | 'remote' | 'coastal';
  /** compass bearing (deg true) from the town toward open water — used to place
   *  coastal / offshore jobs on the correct side, and to push inland jobs away. */
  sea?: number;
};

const ANCHORS: Anchor[] = [
  { name: 'Melbourne', region: 'VIC', lat: -37.75, lon: 144.95, kind: 'metro' },
  { name: 'Geelong', region: 'VIC', lat: -38.15, lon: 144.36, kind: 'regional', sea: 165 },
  { name: 'Bendigo', region: 'VIC', lat: -36.76, lon: 144.28, kind: 'regional' },
  { name: 'Sale', region: 'VIC', lat: -38.1, lon: 147.07, kind: 'regional' },
  { name: 'Mildura', region: 'VIC', lat: -34.23, lon: 142.09, kind: 'remote' },
  { name: 'Portland', region: 'VIC', lat: -38.35, lon: 141.6, kind: 'coastal', sea: 200 },
  { name: 'Sydney', region: 'NSW', lat: -33.87, lon: 151.05, kind: 'metro' },
  { name: 'Newcastle', region: 'NSW', lat: -32.93, lon: 151.75, kind: 'regional', sea: 110 },
  { name: 'Wollongong', region: 'NSW', lat: -34.42, lon: 150.9, kind: 'coastal', sea: 110 },
  { name: 'Wagga Wagga', region: 'NSW', lat: -35.16, lon: 147.46, kind: 'regional' },
  { name: 'Dubbo', region: 'NSW', lat: -32.24, lon: 148.57, kind: 'regional' },
  { name: 'Coffs Harbour', region: 'NSW', lat: -30.32, lon: 153.12, kind: 'coastal', sea: 95 },
  { name: 'Port Macquarie', region: 'NSW', lat: -31.43, lon: 152.91, kind: 'coastal', sea: 100 },
  { name: 'Eden', region: 'NSW', lat: -37.07, lon: 149.9, kind: 'coastal', sea: 135 },
  { name: 'Bega', region: 'NSW', lat: -36.67, lon: 149.84, kind: 'regional' },
  { name: 'Broken Hill', region: 'NSW', lat: -31.95, lon: 141.47, kind: 'remote' },
  { name: 'Brisbane', region: 'QLD', lat: -27.47, lon: 153.0, kind: 'metro' },
  { name: 'Gold Coast hinterland', region: 'QLD', lat: -28.1, lon: 153.3, kind: 'regional' },
  { name: 'Toowoomba', region: 'QLD', lat: -27.56, lon: 151.95, kind: 'regional' },
  { name: 'Rockhampton', region: 'QLD', lat: -23.38, lon: 150.48, kind: 'regional' },
  { name: 'Roma', region: 'QLD', lat: -26.55, lon: 148.79, kind: 'remote' },
  { name: 'Mount Isa', region: 'QLD', lat: -20.66, lon: 139.49, kind: 'remote' },
  { name: 'Cairns', region: 'QLD', lat: -16.87, lon: 145.75, kind: 'coastal', sea: 75 },
  { name: 'Airlie Beach', region: 'QLD', lat: -20.27, lon: 148.72, kind: 'coastal', sea: 70 },
  { name: 'Adelaide Hills', region: 'SA', lat: -34.98, lon: 138.75, kind: 'regional' },
  { name: 'Port Augusta', region: 'SA', lat: -32.49, lon: 137.77, kind: 'remote' },
  { name: 'Mount Gambier', region: 'SA', lat: -37.75, lon: 140.78, kind: 'regional' },
  { name: 'Perth', region: 'WA', lat: -31.95, lon: 116.1, kind: 'metro' },
  { name: 'Bunbury', region: 'WA', lat: -33.33, lon: 115.64, kind: 'coastal', sea: 250 },
  { name: 'Mandurah', region: 'WA', lat: -32.53, lon: 115.72, kind: 'coastal', sea: 260 },
  { name: 'Kalgoorlie', region: 'WA', lat: -30.75, lon: 121.47, kind: 'remote' },
  { name: 'Geraldton', region: 'WA', lat: -28.78, lon: 114.7, kind: 'coastal', sea: 270 },
  { name: 'Broome', region: 'WA', lat: -17.95, lon: 122.23, kind: 'remote', sea: 300 },
  { name: 'Hobart', region: 'TAS', lat: -42.84, lon: 147.44, kind: 'regional', sea: 150 },
  { name: 'Launceston', region: 'TAS', lat: -41.44, lon: 147.14, kind: 'regional' },
  { name: 'Canberra', region: 'ACT', lat: -35.31, lon: 149.13, kind: 'metro' },
  { name: 'Cooma / Snowy Mountains', region: 'NSW', lat: -36.23, lon: 149.13, kind: 'regional' },
  { name: 'Darwin', region: 'NT', lat: -12.45, lon: 130.95, kind: 'regional', sea: 320 },
  { name: 'Katherine', region: 'NT', lat: -14.46, lon: 132.26, kind: 'remote' },
  { name: 'Alice Springs', region: 'NT', lat: -23.7, lon: 133.87, kind: 'remote' },
];

const COASTAL = ANCHORS.filter((a) => a.kind === 'coastal');

const NM_PER_DEG = 60;
function rngNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG;
  const dLon = (lon2 - lon1) * NM_PER_DEG * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Project a point `nm` nautical miles from lat/lon along a true bearing. */
function project(lat: number, lon: number, bearingDeg: number, nm: number): { lat: number; lon: number } {
  const br = (bearingDeg * Math.PI) / 180;
  return {
    lat: lat + (nm * Math.cos(br)) / NM_PER_DEG,
    lon: lon + (nm * Math.sin(br)) / (NM_PER_DEG * Math.cos((lat * Math.PI) / 180)),
  };
}

/** How a job sits on the ground — drives where its coordinates land. */
type Terrain = 'road' | 'urban' | 'rural' | 'bush' | 'coast' | 'offshore' | 'airstrip';

/**
 * Place the incident so the pin agrees with the words: road/urban jobs stay in
 * the town, rural/bush jobs are pushed inland, coast jobs sit on the shoreline,
 * offshore jobs are actually out to sea, airstrip jobs are on the field.
 */
/**
 * Real map features per anchor, pre-baked from OpenStreetMap by
 * scripts/prebake-features.mjs. Without this a "level crossing" job was placed
 * on a random bearing from the town centre and landed in a paddock (or the sea);
 * snapping to a real crossing or a real road is what makes the scene match the
 * brief. Missing/empty is handled everywhere — we simply fall back to the old
 * random placement.
 */
/** The map features a job setting can name. Pre-baked per anchor from OSM. */
export type FeatureKind =
  | 'xing'
  | 'rail'
  | 'majorroad'
  | 'river'
  | 'water'
  | 'powerline'
  | 'pipeline'
  | 'roadhouse'
  | 'caravan'
  | 'residential'
  | 'industrial'
  | 'retail'
  | 'farmland'
  | 'forest'
  | 'reserve'
  | 'park'
  | 'construction'
  | 'quarry'
  | 'marina'
  | 'beach'
  | 'cliff';
type FeatureSet = Partial<Record<FeatureKind, [number, number][]>>;
let FEATURES: Record<string, FeatureSet> = {};
try {
  // This package is ESM ("type": "module"), so `require` does not exist — read
  // the file relative to this module instead. It sits beside jobgen in both
  // src/ (tsx dev) and dist/ (the build copies it; tsc alone does not).
  FEATURES = JSON.parse(readFileSync(new URL('./features.json', import.meta.url), 'utf8'));
} catch {
  /* not generated yet — placement falls back to the random bearing */
}

/**
 * The airport that serves each hospital, for fixed-wing aeromedical.
 *
 * Chosen by runway length rather than by tags: Caloundra and Lake Macquarie
 * both carry IATA codes but are GA strips, and an "airport-ness" heuristic
 * picked them over Sunshine Coast and Newcastle.
 */
type ServingAirport = { name: string; icao: string; lat: number; lon: number };
let HOSPITAL_AIRPORTS: Record<string, ServingAirport> = {};
try {
  HOSPITAL_AIRPORTS = JSON.parse(readFileSync(new URL('./hospital-airports.json', import.meta.url), 'utf8'));
} catch {
  /* not generated yet — fixed-wing jobs fall back to naming the hospital */
}
function airportFor(hospitalName: string): ServingAirport | null {
  return HOSPITAL_AIRPORTS[hospitalName] ?? null;
}

/** Real aerodromes near each anchor, with their ICAO code (same pre-bake). */
type Aerodrome = { name: string; icao: string; lat: number; lon: number };
let AERODROMES: Record<string, Aerodrome[]> = {};
try {
  AERODROMES = JSON.parse(readFileSync(new URL('./aerodromes.json', import.meta.url), 'utf8'));
} catch {
  /* not generated yet — airstrip jobs keep their generic setting text */
}

/** Does this anchor have any of the feature a template needs? */
export function anchorHasFeature(anchorName: string, feature?: FeatureKind): boolean {
  if (!feature) return true;
  return (FEATURES[anchorName]?.[feature]?.length ?? 0) > 0;
}

/**
 * A job that lands ON a line — a road, a railway, a river bank — must not be
 * nudged off it. The old code jittered every feature by 60 m, which is how an
 * "MVA on a bypass road" ended up inside a building in the Toowoomba CBD. The
 * measured offset of the map data itself is ~9 m, so the jitter was the whole
 * problem. Areas can still be spread a little: one end of a suburb is as
 * plausible as the other.
 */
const LINEAR: ReadonlySet<FeatureKind> = new Set<FeatureKind>(['majorroad', 'rail', 'river', 'powerline', 'pipeline', 'xing']);

/** Snap to a real feature of this kind near the anchor. */
function placeOnFeature(anchor: Anchor, feature: FeatureKind): { lat: number; lon: number; offNm: number } | null {
  const list = FEATURES[anchor.name]?.[feature];
  if (!list?.length) return null;
  const [lat, lon] = rand(list);
  const jitterM = LINEAR.has(feature) ? 0 : 120;
  if (!jitterM) return { lat, lon, offNm: 0 };
  const dLat = ((Math.random() - 0.5) * 2 * jitterM) / 111320;
  const dLon = ((Math.random() - 0.5) * 2 * jitterM) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon, offNm: 0 };
}

/**
 * What each setting phrase actually IS on the map.
 *
 * Every template already described its scene precisely — "a residential area",
 * "a catchment", "a bypass road" — but the phrase and the coordinate used to be
 * drawn independently, so the words were decoration and the pin went on a
 * random bearing from the town. This table is what ties them together: the
 * setting is chosen first, and the job is then placed on a real one.
 *
 * Order matters — first match wins.
 */
const SETTING_FEATURE: [RegExp, FeatureKind][] = [
  [/level crossing|rail crossing|grain-line/i, 'xing'],
  [/rail corridor|rail maintenance|railway/i, 'rail'],
  [/highway|freeway|arterial|bypass|truck route|mountain pass|descent|interchange/i, 'majorroad'],
  [/roadhouse/i, 'roadhouse'],
  [/caravan park/i, 'caravan'],
  [/industrial estate/i, 'industrial'],
  [/town centre/i, 'retail'],
  [/residential|suburban/i, 'residential'],
  [/parkland|sports oval|showground/i, 'park'],
  [/national park|state forest|forest|timbered|bushland|forestry|scrub/i, 'forest'],
  [/reserve|ranges?\b|gullies|fire trail/i, 'reserve'],
  [/catchment|reservoir|\bdam\b|\blake\b|weir/i, 'water'],
  [/river|creek|causeway|swollen|floodwater|flood-/i, 'river'],
  [/marina|jetty|boat ramp|slipway|dive charter/i, 'marina'],
  [/beach|foreshore|sand/i, 'beach'],
  [/cliff|rock platform|headland|bluff/i, 'cliff'],
  [/construction site/i, 'construction'],
  [/mine camp|quarry|\bmine\b/i, 'quarry'],
  [/powerline|easement|transmission/i, 'powerline'],
  [/pipeline/i, 'pipeline'],
  [/grazing|cropping|paddock|farm|station|shearing|rural block|stubble|orchard|irrigator|homestead|outstation|bore run/i, 'farmland'],
];

function featureForSetting(setting: string): FeatureKind | null {
  for (const [re, kind] of SETTING_FEATURE) if (re.test(setting)) return kind;
  return null;
}

function placePoint(anchor: Anchor, terrain: Terrain): { lat: number; lon: number; offNm: number } {
  const spread = (deg: number) => (Math.random() - 0.5) * 2 * deg;
  const inland = anchor.sea != null ? anchor.sea + 180 : Math.random() * 360;
  switch (terrain) {
    case 'offshore': {
      const nm = 3 + Math.random() * 12;
      return { ...project(anchor.lat, anchor.lon, (anchor.sea ?? 90) + spread(35), nm), offNm: Math.round(nm) };
    }
    case 'coast': {
      const nm = 0.2 + Math.random() * 1.6;
      return { ...project(anchor.lat, anchor.lon, (anchor.sea ?? 90) + spread(50), nm), offNm: 0 };
    }
    case 'bush': {
      const nm = 8 + Math.random() * 22;
      return { ...project(anchor.lat, anchor.lon, inland + spread(70), nm), offNm: 0 };
    }
    case 'rural': {
      const nm = 4 + Math.random() * 13;
      return { ...project(anchor.lat, anchor.lon, inland + spread(110), nm), offNm: 0 };
    }
    case 'airstrip':
      return { lat: anchor.lat + spread(0.025), lon: anchor.lon + spread(0.025), offNm: 0 };
    case 'road':
    case 'urban':
    default: {
      const nm = 1 + Math.random() * 6;
      return { ...project(anchor.lat, anchor.lon, Math.random() * 360, nm), offNm: 0 };
    }
  }
}

// ---- Australian hospitals (HEMS receiving and referring sites) ------
// Built from OpenStreetMap by scratchpad/build.mjs and audited against the
// `simfocus-autogen-helipads-world-2024` package: every entry is a real
// hospital, its region comes from a point-in-polygon test against the state
// boundaries, and where the sim has a helipad on site the coordinate is SNAPPED
// to that pad so the transport leg ends somewhere the player can land.
//
//   major  a tertiary/trauma centre - the destination for definitive care
//   pad    ident in the MSFS helipad package (166 of them have one)
//   ed     present and false only when the hospital has NO emergency department:
//          it can refer a patient out, but nobody is flown TO it
type HospitalRow = Hospital & { region: string; major?: boolean; ed?: false };
let HOSPITALS: HospitalRow[];
try {
  // Same ESM-safe read as features.json - see the note there.
  HOSPITALS = JSON.parse(readFileSync(new URL('./hospitals.json', import.meta.url), 'utf8')) as HospitalRow[];
} catch (err) {
  // Unlike features/aerodromes there is no sane fallback: with no hospitals
  // every transport job would have nowhere to go. Fail loudly at boot instead.
  throw new Error(
    'jobgen: could not read hospitals.json next to this module. ' +
      'It ships in src/ and is copied to dist/ by scripts/copy-assets.mjs — ' +
      `run "npm run build" before starting. (${(err as Error).message})`,
  );
}

/** Hospitals a patient can be flown TO: everything with an emergency department. */
const RECEIVING = HOSPITALS.filter((h) => h.ed !== false);

/**
 * How far a patient-transport job must be from its receiving hospital before an
 * air asset is credible tasking.
 *
 * A road ambulance beats a helicopter over short distances — an MVA 500 m from
 * Royal Brisbane is a two-minute drive, not a HEMS job. Real HEMS thresholds sit
 * around 30-45 minutes of road time; 20 NM (~37 km) is the rough equivalent.
 * Fixed-wing aeromedical only makes sense much further out again.
 */
const MIN_TRANSPORT_NM: Record<string, number> = { rotary: 20, fixed: 60 };

/**
 * The referring hospital for a transfer: a real, NON-tertiary hospital near the
 * anchor — you transfer *from* a district hospital *to* a major centre, never
 * the other way round. Prefers one with a sim helipad so the pickup is landable.
 */
function referringHospital(anchor: Anchor, min = MIN_TRANSPORT_NM.rotary ?? 0): HospitalRow | null {
  // Far enough from its tertiary centre to be worth flying: Lyell McEwin to the
  // Royal Adelaide is 11 NM and goes by road.
  const near = HOSPITALS.filter((h) => {
    if (h.major || rngNm(anchor.lat, anchor.lon, h.lat, h.lon) > 160) return false;
    const m = nearestHospital(h.lat, h.lon, true);
    return rngNm(h.lat, h.lon, m.lat, m.lon) >= min;
  });
  if (!near.length) return null;
  const withPad = near.filter((h) => h.pad);
  return rand(withPad.length ? withPad : near);
}

/**
 * The nearest hospital to `from` that is far enough away to be worth flying,
 * excluding `from` itself.
 *
 * Not every transfer runs to a capital: Lismore to Tweed Valley is 36 NM and is
 * a routine urgent transfer, with both ends regional. Restricting destinations
 * to the tertiary centres alone made that pairing impossible to generate.
 */
function transferPartner(from: Hospital, minNm: number): Hospital | null {
  const options = RECEIVING.filter((h) => h.name !== from.name && rngNm(from.lat, from.lon, h.lat, h.lon) >= minNm);
  if (!options.length) return null;
  const withPad = options.filter((h) => h.pad);
  const pool = withPad.length ? withPad : options;
  let best = pool[0]!;
  let bestD = Infinity;
  for (const h of pool) {
    const d = rngNm(from.lat, from.lon, h.lat, h.lon);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** Nearest real hospital helipad to a point (used for the patient-transport leg). */
function nearestHospital(lat: number, lon: number, majorOnly = false): Hospital {
  const pool = majorOnly ? RECEIVING.filter((h) => h.major) : RECEIVING;
  let best = pool[0]!;
  let bestD = Infinity;
  for (const h of pool) {
    const d = rngNm(lat, lon, h.lat, h.lon);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return { name: best.name, lat: best.lat, lon: best.lon, pad: best.pad };
}

// ---- op templates ---------------------------------------------------

type DetailCtx = {
  loc: string;
  town: string;
  region: string;
  hospital?: string;
  night: boolean;
  /** the roads a pursuit runs along, already formatted ("the Hume Fwy, then Sydney Rd") */
  roads?: string;
};

type Tpl = {
  kind: string;
  category: string;
  cls: AircraftClass;
  agencies: [string, string][]; // [name, callsign]
  /** snap the job onto a real OSM feature instead of a random bearing */
  feature?: FeatureKind;
  /** relative weight in the pool (default 1) */
  weight?: number;
  p1: number;
  p2: number;
  transport?: boolean;
  /**
   * Destination is a tertiary centre rather than the nearest hospital. True for
   * retrievals AND for serious trauma: a trapped patient goes to a trauma
   * centre, not to the nearest cottage hospital.
   */
  toDefinitiveCare?: boolean;
  /**
   * The patient is already IN a hospital: place the job on a real (non-tertiary)
   * hospital helipad rather than a random point, and fly them to definitive
   * care. Without this an "inter-hospital transfer" starts in a paddock.
   */
  fromHospital?: boolean;
  /**
   * A retrieval or inter-hospital transfer, where flying the patient IS the job.
   * These skip the distance floor — unlike a scene job, there is no "a road
   * ambulance would have taken this" alternative to fall back to.
   */
  alwaysTransports?: boolean;
  offshore?: boolean;
  anchorKinds?: Anchor['kind'][];
  /** where the incident physically sits — controls coordinate placement */
  terrain: Terrain;
  /** setting phrases that agree with `terrain` (empty = use the town name) */
  settings: string[];
  /**
   * This job spawns a MOVING ground or surface target for the crew to track —
   * the car in a pursuit, a convoy, a vessel of interest. The route follows the
   * real road graph where the anchor has one (see roads.ts).
   */
  pursuit?: {
    vehicle: GroundTarget['vehicle'];
    behaviour: GroundTarget['behaviour'];
    /** speed ceiling profile for a road vehicle */
    profile?: FleeProfile;
    /** how long the run should last, MINUTES [min, max] — see roads.ts on why
     *  this is budgeted by time and not by distance */
    mins?: [number, number];
    /** more than one vehicle, in trail */
    convoy?: [number, number];
    /** what the tracking panel calls it */
    label: string[];
  };
  /** clinical one-liner flavour, if this job carries a patient */
  cas?: CasKind;
  /** extra template-specific complication lines mixed into the shared pool */
  complications?: string[];
  brief: string[];
  /** the opening line(s); the engine appends casualty + complication + weather */
  detail: (c: DetailCtx) => string;
  hazards: string[];
  persons: string[];
  access: string[];
  lz: string[];
};

const HEMS_AGENCIES: [string, string][] = [
  ['Ambulance Victoria', 'HEMS'],
  ['NSW Ambulance', 'Rescue'],
  ['LifeFlight', 'Rescue'],
  ['RACQ LifeFlight Rescue', 'Rescue'],
  ['Westpac Life Saver Rescue', 'Lifesaver'],
  ['CareFlight', 'CareFlight'],
  ['SA Ambulance MedSTAR', 'MedSTAR'],
  ['RAC Rescue (WA)', 'Rescue'],
  ['Ambulance Tasmania', 'Rescue'],
  ['ACT Ambulance Service', 'Rescue'],
];

/**
 * State and territory POLICE air wings. Every jurisdiction runs its own, so a
 * job in Perth should say "WA Police Air Wing", not a generic "Police Aviation".
 */
const POLICE_AGENCIES: [string, string][] = [
  ['NSW Police Force PolAir', 'PolAir'],
  ['Victoria Police Air Wing', 'Polair'],
  ['Queensland Police Service Polair', 'Polair'],
  ['Western Australia Police Force Air Wing', 'Polair'],
  ['SA Police PolAir', 'PolAir'],
  ['Tasmania Police Air Wing', 'PolAir'],
  ['NT Police Air Wing', 'PolAir'],
  ['ACT Policing (AFP)', 'PolAir'],
];

/** State and territory FIRE services with an aviation arm. */
const FIRE_AGENCIES: [string, string][] = [
  ['NSW RFS Aviation', 'Firebird'],
  ['CFA / FRV Aircraft', 'Firebird'],
  ['Queensland Fire Department', 'Firebird'],
  ['DFES Western Australia', 'Firebird'],
  ['SA Country Fire Service', 'Firebird'],
  ['Tasmania Fire Service', 'Firebird'],
  ['NT Fire and Rescue Service', 'Firebird'],
  ['ACT Rural Fire Service', 'Firebird'],
  ['National Aerial Firefighting', 'Bomber'],
];

/**
 * Maritime tasking is a police air wing job, but on the water the Australian
 * Border Force and Maritime Border Command task it too — a vessel of interest
 * inbound from offshore is theirs, not a state force's.
 */
const MARITIME_AGENCIES: [string, string][] = [
  ...POLICE_AGENCIES,
  ['Australian Border Force', 'Border'],
  ['Maritime Border Command', 'Border'],
];

/**
 * State and territory PARKS / conservation services. DBCA is Western
 * Australia's department — it was previously listed as the national parks
 * agency, which put a WA ranger on a South Australian catchment survey.
 */
const PARKS_AGENCIES: [string, string][] = [
  ['NSW National Parks and Wildlife Service', 'Ranger'],
  ['Parks Victoria', 'Ranger'],
  ['Queensland Parks and Wildlife Service', 'Ranger'],
  ['Parks and Wildlife Service (DBCA)', 'Ranger'],
  ['National Parks and Wildlife Service SA', 'Ranger'],
  ['Tasmania Parks and Wildlife Service', 'Ranger'],
  ['NT Parks and Wildlife', 'Ranger'],
  ['ACT Parks and Conservation Service', 'Ranger'],
];

// Where each agency actually operates (`'*'` = national). Adjacent states can
// appear as a border-town exception.
const REGION_ADJ: Record<string, string[]> = {
  VIC: ['NSW', 'SA', 'TAS'],
  NSW: ['VIC', 'QLD', 'SA', 'ACT'],
  ACT: ['NSW'],
  QLD: ['NSW', 'NT', 'SA'],
  SA: ['VIC', 'NSW', 'QLD', 'NT', 'WA'],
  WA: ['SA', 'NT'],
  NT: ['QLD', 'SA', 'WA'],
  TAS: ['VIC'],
};
const AGENCY_REGIONS: Record<string, string[] | '*'> = {
  'Ambulance Victoria': ['VIC'],
  'Ambulance': ['VIC', 'NSW'],
  'NSW Ambulance': ['NSW'],
  'NSW Air Ambulance': ['NSW'],
  LifeFlight: ['QLD'],
  'RACQ LifeFlight Rescue': ['QLD'],
  'Westpac Life Saver Rescue': ['NSW'],
  CareFlight: ['NSW', 'NT'],
  'SA Ambulance MedSTAR': ['SA'],
  'RAC Rescue (WA)': ['WA'],
  'Ambulance Tasmania': ['TAS'],
  'ACT Ambulance Service': ['ACT'],

  // police air wings — one per jurisdiction
  'NSW Police Force PolAir': ['NSW', 'ACT'],
  'Victoria Police Air Wing': ['VIC'],
  'Queensland Police Service Polair': ['QLD'],
  'Western Australia Police Force Air Wing': ['WA'],
  'SA Police PolAir': ['SA'],
  'Tasmania Police Air Wing': ['TAS'],
  'NT Police Air Wing': ['NT'],
  'ACT Policing (AFP)': ['ACT'],

  // fire services with an aviation arm
  'NSW RFS Aviation': ['NSW'],
  'CFA / FRV Aircraft': ['VIC'],
  'Queensland Fire Department': ['QLD'],
  'DFES Western Australia': ['WA'],
  'SA Country Fire Service': ['SA'],
  'Tasmania Fire Service': ['TAS'],
  'NT Fire and Rescue Service': ['NT'],
  'ACT Rural Fire Service': ['ACT'],
  'Royal Flying Doctor Service': '*',
  'Police Aviation': '*',
  'National Aerial Firefighting': '*',
  'AMSA / JRCC Australia': '*',
  'JRCC Australia': '*',
  'Australian Border Force': '*',
  'Maritime Border Command': '*',
  'Marine Rescue': '*',
  'NSW National Parks and Wildlife Service': ['NSW'],
  'Parks Victoria': ['VIC'],
  'Queensland Parks and Wildlife Service': ['QLD'],
  'Parks and Wildlife Service (DBCA)': ['WA'],
  'National Parks and Wildlife Service SA': ['SA'],
  'Tasmania Parks and Wildlife Service': ['TAS'],
  'NT Parks and Wildlife': ['NT'],
  'ACT Parks and Conservation Service': ['ACT'],
  'Aerial Survey Operations': '*',
};

/**
 * Which anchors are genuinely close to another jurisdiction (within 150 km of
 * its boundary), so a cross-border tasking reads as a real border arrangement.
 *
 * The interstate exception used to apply to any anchor in the state, which put
 * Queensland Parks and Wildlife on a catchment at Bega — 900 km away. Generated
 * from the state boundaries; Bass Strait is excluded because it is not a border
 * anyone gets tasked across.
 */
const ANCHOR_BORDERS: Record<string, string[]> = {
  'Bendigo': ['NSW'],
  'Mildura': ['NSW', 'SA'],
  'Portland': ['SA'],
  'Wagga Wagga': ['VIC'],
  'Eden': ['VIC'],
  'Bega': ['VIC'],
  'Brisbane': ['NSW'],
  'Gold Coast hinterland': ['NSW'],
  'Toowoomba': ['NSW'],
  'Mount Gambier': ['VIC'],
  'Canberra': ['NSW'],
  'Cooma / Snowy Mountains': ['VIC'],
};

/** Pick an agency that covers this region, or a neighbour's if this really is a border town. */
function pickAgency(list: [string, string][], region: string, anchorName?: string): [string, string] {
  const home = list.filter((a) => {
    const r = AGENCY_REGIONS[a[0]];
    return r === '*' || (Array.isArray(r) && r.includes(region));
  });
  // Only a genuine border town may borrow the neighbour's service, AND the
  // neighbour must actually adjoin the region the job is in. A transfer can
  // start in a different state from its anchor, which is how an anchor whose
  // neighbours include the ACT lent an ACT crew to a Victorian hospital.
  const neighbours = (anchorName ? (ANCHOR_BORDERS[anchorName] ?? []) : (REGION_ADJ[region] ?? [])).filter((x) =>
    (REGION_ADJ[region] ?? []).includes(x),
  );
  const adj = list.filter((a) => {
    const r = AGENCY_REGIONS[a[0]];
    return Array.isArray(r) && neighbours.some((x) => r.includes(x));
  });
  if (home.length && (!adj.length || Math.random() > 0.15)) return rand(home);
  if (adj.length) return rand(adj);
  if (home.length) return rand(home);
  // Nothing in this scenario's list operates here. Prefer a national body over
  // an interstate one — "RFDS" in the Kimberley reads fine, "Ambulance
  // Victoria" does not. If the list has no national body either, invent a
  // neutral one rather than returning a state brand that cannot be there:
  // falling back to rand(list) is what put NSW Ambulance on a WA boat ramp.
  const national = list.filter((a) => AGENCY_REGIONS[a[0]] === '*');
  if (national.length) return rand(national);
  const unbranded = list.filter((a) => !AGENCY_REGIONS[a[0]]);
  if (unbranded.length) return rand(unbranded);
  return ['State Rescue Helicopter', 'Rescue'];
}

// ---- composition fragments -----------------------------------------
// A job's `detail` is assembled from a template lead + shared fragments so the
// space of distinct briefings is very large (mechanism × patient × complication
// × access × weather × time of day), not one canned paragraph per template.

/** Realistic callsigns per aviation unit; falls back to `${cs} ${n}`. */
const CALLSIGN_BANK: Record<string, string[]> = {
  'Ambulance Victoria': ['HEMS 1', 'HEMS 2', 'HEMS 3', 'HEMS 4', 'HEMS 5'],
  'NSW Ambulance': ['Rescue 21', 'Rescue 22', 'Rescue 23', 'Rescue 26', 'Rescue 27', 'Rescue 28'],
  LifeFlight: ['Rescue 500', 'Rescue 511', 'Rescue 521', 'Rescue 531'],
  'RACQ LifeFlight Rescue': ['Rescue 300', 'Rescue 310', 'Rescue 320', 'Rescue 500'],
  'Westpac Life Saver Rescue': ['Lifesaver 21', 'Lifesaver 22', 'Lifesaver 23', 'Lifesaver 1'],
  CareFlight: ['CareFlight 1', 'CareFlight 2', 'CareFlight 6', 'CareFlight 8'],
  'SA Ambulance MedSTAR': ['MedSTAR 1', 'MedSTAR 2', 'Rescue 65'],
  'RAC Rescue (WA)': ['Rescue 641', 'Rescue 646', 'Rescue 651'],
  'Royal Flying Doctor Service': ['Flying Doctor 1', 'Flying Doctor 6', 'Ambulance 200', 'Rescue 234'],
  'NSW Air Ambulance': ['Ambulance 250', 'Ambulance 251'],
  'Police Aviation': ['PolAir 1', 'PolAir 2', 'PolAir 4', 'PolAir 5', 'PolAir 6', 'PolAir 9'],
  'NSW RFS Aviation': ['Firebird 200', 'Firebird 201', 'Firebird 231', 'Firebird 270'],
  'CFA / FRV Aircraft': ['Firebird 300', 'Firebird 310', 'Firebird 383', 'Firebird 388'],
  'National Aerial Firefighting': ['Bomber 391', 'Bomber 737', 'Bomber 910', 'Birddog 1'],
  'AMSA / JRCC Australia': ['Rescue 465', 'Rescue 466', 'Rescue 001'],
  'Australian Border Force': ['Border 610', 'Border 620'],
  'Maritime Border Command': ['Border 630', 'Border 640'],
  // The state air wings all fly as "Polair", numbered per jurisdiction.
  'NSW Police Force PolAir': ['PolAir 1', 'PolAir 2', 'PolAir 3', 'PolAir 4', 'PolAir 5', 'PolAir 6'],
  'Victoria Police Air Wing': ['Polair 1', 'Polair 2', 'Polair 3', 'Polair 4', 'Polair 5'],
  'Queensland Police Service Polair': ['Polair 1', 'Polair 2', 'Polair 3', 'Polair 4', 'Polair 5'],
  'Western Australia Police Force Air Wing': ['Polair 61', 'Polair 62', 'Polair 63'],
  'SA Police PolAir': ['PolAir 1', 'PolAir 2'],
  'Tasmania Police Air Wing': ['PolAir 1', 'PolAir 2'],
  'NT Police Air Wing': ['PolAir 1', 'PolAir 2'],
  'ACT Policing (AFP)': ['PolAir 1', 'PolAir 2'],
};
function callsignFor(agency: string, cs: string): string {
  const bank = CALLSIGN_BANK[agency];
  return bank ? rand(bank) : `${cs} ${rint(1, 9)}`;
}

/** Time of day, biased by server clock (AEST) with a 30% "make it night" nudge. */
function daypart(): { night: boolean; label: string } {
  const localH = (new Date().getUTCHours() + 10) % 24;
  const night = localH < 6 || localH >= 20 || Math.random() < 0.3;
  const label = night ? 'overnight' : localH < 10 ? 'this morning' : localH < 16 ? 'this afternoon' : 'this evening';
  return { night, label };
}

function wx(night: boolean): { text: string; imc: boolean; note: string } {
  const dir = rint(0, 35) * 10 || 360;
  const spd = rint(3, 28);
  const gust = chance(0.3) ? ` G${spd + rint(6, 16)}` : '';
  const lowVis = chance(0.28);
  const vis = lowVis ? rand(['4 km HZ', '5 km', '6 km BR', '3000 m FG']) : rand(['10 km', '10 km', '30 km', '9999']);
  const lowCloud = chance(0.3);
  const cloud = lowCloud ? rand(['BKN008', 'OVC012', 'BKN010', 'SCT006 BKN015']) : rand(['FEW030', 'SCT025', 'SCT040', 'FEW045', 'CAVOK']);
  const qnh = rint(1002, 1027);
  const imc = lowVis || lowCloud;
  const note = imc
    ? 'IMC on task — plan an instrument arrival and carry holding fuel.'
    : night
      ? 'Night tasking — reduced horizon, brief obstacle lighting and terrain; NVG if fitted.'
      : chance(0.4)
        ? 'A strong wind change is forecast through the area — expect turbulence and a rough handling zone.'
        : '';
  return { text: `Wind ${String(dir).padStart(3, '0')}/${spd}${gust} kt · Vis ${vis} · ${cloud} · QNH ${qnh}`, imc, note };
}

// -- clinical one-liners ------------------------------------------------
type CasKind = 'trauma' | 'medical' | 'obs' | 'paeds' | 'burns' | 'marine' | 'entrap';
const SEX = ['M', 'F'];
const TRAUMA_MECH = [
  'open tib/fib fracture',
  'flail chest and haemothorax',
  'suspected pelvic fracture',
  '# femur, splinted',
  'head injury with a scalp laceration',
  'penetrating abdominal injury',
  'crush injury to both legs',
  'traumatic amputation below the knee',
  'high-speed deceleration, ? aortic injury',
];
const MED_PROB = [
  'central crushing chest pain, diaphoretic — ? STEMI',
  'sudden severe headache, GCS falling — ? subarachnoid',
  'dense left-sided weakness, onset 40 min ago — ? CVA for thrombectomy',
  'prolonged seizure, now post-ictal and hypoxic',
  'anaphylaxis to a bee sting, two doses of adrenaline given',
  'DKA, drowsy, profoundly dehydrated',
  'massive PR bleed, shocked',
];
const VITALS = ['tachycardic and pale', 'hypotensive, cool peripheries', 'maintaining but marginal', 'GCS 13, agitated', 'GCS 8, intubated', 'SpO2 88% on high-flow'];
function makeCasualty(kind: CasKind): string {
  const sex = rand(SEX);
  const age = kind === 'paeds' ? rint(1, 14) : kind === 'obs' ? rint(18, 41) : rint(17, 88);
  switch (kind) {
    case 'trauma':
    case 'entrap':
      return `${sex}/${age}, ${rand(TRAUMA_MECH)}, ${rand(VITALS)}.`;
    case 'medical':
      return `${sex}/${age}, ${rand(MED_PROB)}, ${rand(VITALS)}.`;
    case 'obs':
      return `F/${age}, ${rint(28, 40)}/40, ${rand(['PV bleeding with 3-minutely contractions — ? abruption', 'severe pre-eclampsia, BP 180/115, brisk reflexes', 'cord prolapse, foot presenting', 'reduced fetal movements and abdominal pain'])}.`;
    case 'paeds':
      return `${sex}/${age}, ${rand(['submersion, GCS 8, hypothermic', 'severe croup, stridor at rest', 'febrile, non-blanching rash — ? meningococcaemia', 'blunt abdominal trauma from a fall', 'status asthmaticus, silent chest'])}.`;
    case 'burns':
      return `${sex}/${age}, ${rint(12, 45)}% TBSA ${rand(['flame', 'scald', 'chemical'])} burns to ${rand(['torso and arms', 'face and airway — intubated', 'both legs'])}, ${rand(VITALS)}.`;
    case 'marine':
      return `${sex}/${age}, ${rand(['near-drowning, coughing frothy sputum', 'suspected spinal from a dumping wave', 'decompression illness after a deep dive — joint pain and paraesthesia', 'hypothermic after 90 min in the water'])}.`;
    default:
      return `${sex}/${age}, unwell, further details to follow.`;
  }
}

const COMPLICATIONS = [
  'Access is the problem — the nearest road crew is 40+ minutes away.',
  'Second patient now reported, less injured, walking.',
  'Family on scene and distressed; police en route for scene control.',
  'Powerlines cross the only clear approach — survey before committing.',
  'Livestock and a centre-pivot irrigator in the paddock; owner clearing it now.',
  'The reporting person has lost phone coverage — position is approximate.',
  'Fading light — get overhead before last light if you can.',
  'A road ambulance is close and may beat you; confirm tasking on arrival.',
  'Fuel will be tight for the round trip — plan a top-up on the way back.',
];
const ACCESS_NOTES = [
  'Ground contact will mark the LZ with a strobe and stand upwind.',
  'HLS is a stubble paddock, firm, slight downslope to the south.',
  'Landing area is a closed section of road between two appliances.',
  'Confined area, one-way in and out; brief a committed approach.',
  'Sports oval adjacent, floodlit, powerlines along the western boundary.',
  'No prepared LZ — assess a winch or a one-skid on arrival.',
];

/** "the Hume Freeway, then onto Sydney Road" — reads the road names into a brief. */
function formatRoads(roads: string[]): string {
  const r = roads.filter(Boolean).slice(0, 3);
  if (!r.length) return '';
  if (r.length === 1) return r[0]!;
  return `${r.slice(0, -1).join(', ')}, then ${r[r.length - 1]}`;
}

/**
 * A plausible registration for the jurisdiction. Every state runs its own
 * format, and "ABC 123" on a Victorian pursuit is the kind of detail that
 * reads wrong to anyone who lives here.
 */
function plate(region: string): string {
  const L = () => 'ABCDEFGHJKLMNPRSTUVWXYZ'[rint(0, 22)]!;
  const D = () => String(rint(0, 9));
  switch (region) {
    case 'VIC':
      return `${D()}${L()}${L()}·${D()}${L()}${L()}`;
    case 'NSW':
      return `${L()}${L()} ${D()}${D()} ${L()}${L()}`;
    case 'QLD':
      return `${D()}${D()}${D()} ${L()}${L()}${L()}`;
    case 'WA':
      return `${D()}${L()}${L()}${L()} ${D()}${D()}${D()}`;
    case 'SA':
      return `S${D()}${D()}${D()} ${L()}${L()}${L()}`;
    case 'TAS':
      return `${L()}${D()}${D()} ${L()}${L()}`;
    case 'NT':
      return `CA ${D()}${D()} ${L()}${L()}`;
    case 'ACT':
      return `Y${L()}${L()} ${D()}${D()}${L()}`;
    default:
      return `${L()}${L()}${L()} ${D()}${D()}${D()}`;
  }
}

const TEMPLATES: Tpl[] = [
  {
    kind: 'MVA with Entrapment',
    toDefinitiveCare: true,
    feature: 'majorroad',
    category: 'HEMS / trauma',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    weight: 3,
    p1: 0.9,
    p2: 0.1,
    transport: true,
    terrain: 'road',
    cas: 'entrap',
    settings: ['the highway corridor', 'a state highway', 'a rural arterial road', 'a freeway interchange', 'a truck route', 'a bypass road'],
    brief: ['Vehicle vs truck, one trapped, fire service extricating.', 'Two vehicles, one critical patient trapped.', 'Single vehicle into a tree at speed, one ejected.'],
    detail: (c) =>
      `Road crash on ${c.loc}. A patient is trapped and being cut free; road ambulance on scene requesting rapid air transport to ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Live traffic, fuel spill, powerlines nearby', 'Unstable vehicle, sharp metal, crowd'],
    persons: ['1 trapped (critical), 1 walking wounded', '1 critical, 2 minor'],
    access: ['Road carriageway; ground crews via the nearest on-ramp'],
    lz: ['Closed carriageway ~200 m, marked by an appliance'],
  },
  {
    kind: 'Medical Retrieval — Rural Property',
    toDefinitiveCare: true,
    alwaysTransports: true,
    category: 'Aeromedical',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    weight: 2,
    p1: 0.6,
    p2: 0.35,
    transport: true,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    cas: 'trauma',
    settings: ['a grazing property', 'a cropping property', 'a station homestead', 'a rural block', 'a shearing shed', 'an orchard block'],
    brief: ['Fall from a silo on a rural property.', 'Quad-bike rollover, single patient.', 'Machinery entanglement in a shed.'],
    detail: (c) =>
      `A worker has been seriously injured at ${c.loc}. Road crew is heavily delayed; retrieval requested for transport to ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Uneven terrain, livestock, single-wire earth-return powerline', 'Poor phone coverage, dust'],
    persons: ['1 patient, ~3 bystanders'],
    access: ['Property gate off the main road, then 4WD track'],
    lz: ['Home paddock, owner to mark with a vehicle'],
  },
  {
    kind: 'Coastal / Cliff Rescue',
    toDefinitiveCare: true,
    category: 'Rescue / winch',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    weight: 2,
    p1: 0.8,
    p2: 0.2,
    transport: true,
    anchorKinds: ['coastal'],
    terrain: 'coast',
    cas: 'trauma',
    settings: ['the sea cliffs', 'a rock platform', 'a coastal walking track', 'a headland', 'the base of the cliffs', 'a surf beach'],
    brief: ['Fallen climber on the cliffs.', 'Cut-off walkers, rising tide.', 'Rock-fisher swept off, recovered by SLS.'],
    detail: (c) =>
      `Casualty at ${c.loc}. Police Rescue and Surf Life Saving on the cliff top; no vehicle access. Winch recovery, then transport to ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Cliff edge, loose rock, swell and spray', 'Rising tide, turbulence off the headland'],
    persons: ['1 casualty (serious), rescuers on scene'],
    access: ['No ground access — winch only'],
    lz: ['Winch to the casualty, transfer on the cliff-top reserve'],
  },
  {
    kind: 'Swiftwater / Flood Rescue',
    toDefinitiveCare: true,
    category: 'Rescue / winch',
    cls: 'rotary',
    // HEMS_AGENCIES covers all eight jurisdictions; the old hand-picked list
    // was NSW/QLD/VIC only, so a WA flood drew a Queensland crew.
    agencies: HEMS_AGENCIES,
    weight: 2,
    p1: 0.85,
    p2: 0.15,
    transport: true,
    anchorKinds: ['regional', 'remote', 'coastal'],
    terrain: 'rural',
    cas: 'marine',
    settings: ['a flooded causeway', 'a swollen river crossing', 'a low-lying caravan park', 'a cut-off farmhouse', 'a stranded vehicle on a floodway'],
    brief: ['Vehicle in floodwater, occupants on the roof.', 'Family stranded on a rooftop as water rises.', 'Camper cut off on an island in the river.'],
    detail: (c) =>
      `People trapped by rising floodwater at ${c.loc}. Ground crews can't reach them. Winch or one-skid recovery, then transport to ${c.hospital ?? `${c.town} hospital`} if injured.`,
    hazards: ['Debris in the flow, submerged fences and wires', 'Fast-rising water, failing light'],
    persons: ['3–4 persons, 1 elderly', '2 adults + 2 children on a roof'],
    access: ['No ground access — winch / hover only'],
    lz: ['High ground on the flood-free side, ground party to mark'],
  },
  {
    kind: 'Structure Fire — Persons Reported',
    toDefinitiveCare: true,
    category: 'HEMS / trauma',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.8,
    p2: 0.2,
    transport: true,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    cas: 'burns',
    settings: ['a homestead', 'a rural workshop', 'a shed complex', 'a roadhouse'],
    brief: ['House fire, one person rescued with burns.', 'Shed fire with an explosion, worker burned.'],
    detail: (c) =>
      `Fire service has rescued a person with significant burns from a fire at ${c.loc}. Airway is a concern. Transport to ${c.hospital ?? `${c.town} hospital`} then likely on to a burns unit.`,
    hazards: ['Smoke, radiant heat, gas cylinders, ember attack', 'Fire appliances and hose lines across the approach'],
    persons: ['1 serious burns, 1 minor (smoke inhalation)'],
    access: ['Driveway off the main road; stage clear of the fire ground'],
    lz: ['Paddock upwind of the smoke, appliance to mark'],
  },
  {
    kind: 'Level Crossing — Train vs Vehicle',
    toDefinitiveCare: true,
    feature: 'xing',
    category: 'HEMS / trauma',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.95,
    p2: 0.05,
    transport: true,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    cas: 'trauma',
    settings: ['an open level crossing', 'a rail crossing on a rural road', 'a grain-line crossing'],
    brief: ['Freight train vs truck at a level crossing, one critical.', 'Car vs train, occupants extricated.'],
    detail: (c) =>
      `Train vs vehicle at ${c.loc}. Rail traffic stopped. One critically injured patient extricated; requesting rapid air transport to ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Adjacent live rail lines, spilled freight, fuel', 'Media and onlookers, narrow road access'],
    persons: ['1 critical, 1 deceased, driver of the train uninjured but shocked'],
    access: ['Rural road either side of the crossing'],
    lz: ['Closed road or the adjacent paddock'],
  },
  {
    kind: 'Bus / Coach Rollover — Multi-Casualty',
    toDefinitiveCare: true,
    feature: 'majorroad',
    category: 'HEMS / trauma',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.9,
    p2: 0.1,
    transport: true,
    terrain: 'road',
    cas: 'trauma',
    settings: ['a highway descent', 'a mountain pass', 'a rural arterial road', 'a freeway curve'],
    brief: ['Tourist coach rollover, multiple patients.', 'School bus off the road down an embankment.'],
    detail: (c) =>
      `Coach rollover on ${c.loc} with multiple casualties. A multi-casualty response is running; you are tasked for the most critical patient for ${c.hospital ?? `${c.town} hospital`}. Expect a second aircraft.`,
    hazards: ['Patients spread down an embankment, fuel, unstable vehicle', 'Multiple aircraft and road units converging'],
    persons: ['~20 aboard: 3 critical, 6 serious, remainder minor'],
    access: ['Highway, closed in both directions'],
    lz: ['Closed carriageway; a triage/loading point will be marked'],
  },
  {
    kind: 'Search / Offender Containment',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.3,
    p2: 0.5,
    anchorKinds: ['metro', 'regional'],
    terrain: 'urban',
    settings: ['an industrial estate', 'the suburban fringe', 'a parkland reserve', 'the town centre', 'a residential area', 'a rail corridor'],
    brief: ['Armed offenders fled a vehicle stop.', 'Pursuit terminated, offenders on foot.', 'Break-and-enter offenders running between yards.'],
    detail: (c) =>
      `Ground units request airborne observation around ${c.loc}. Dog unit and general duties establishing a cordon. Relay movement, coordinate the cordon, downlink if available.`,
    hazards: ['Powerlines, towers, other aircraft', 'Built-up area, noise abatement'],
    persons: ['N/A — observation and coordination'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Missing Person — Bushland Search',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [...POLICE_AGENCIES, ...PARKS_AGENCIES, ['AMSA / JRCC Australia', 'Rescue']],
    p1: 0.4,
    p2: 0.45,
    anchorKinds: ['regional', 'remote'],
    terrain: 'bush',
    settings: ['a national park', 'a state forest', 'a range and its gullies', 'a network of fire trails', 'scrub near a walking track'],
    brief: ['Overdue bushwalker, last seen 18 hours ago.', 'Missing dementia patient from a rural home.', 'Child separated from a family group on a walk.'],
    detail: (c) =>
      `Land search is running near ${c.loc}. Aircraft tasked to search the assigned sectors, work the creek lines and ridges, and coordinate ground teams onto any find. FLIR if fitted.`,
    hazards: ['Rising terrain, wires across valleys, other search aircraft', 'Fatigue on a long tasking, fading light'],
    persons: ['1 misper; ~30 ground searchers in the area'],
    access: ['N/A — search sectors'],
    lz: ['Staging area at the search base / trailhead'],
  },
  // ---- police aviation ------------------------------------------------
  // The air wing's bread and butter. A pursuit, a shadow and a convoy job all
  // spawn a vehicle that actually drives the road network (see roads.ts); the
  // rest are the overwatch and search tasking that fills the rest of a shift.
  {
    kind: 'Vehicle Pursuit — Airborne Tracking',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    weight: 3,
    p1: 0.8,
    p2: 0.18,
    anchorKinds: ['metro', 'regional'],
    terrain: 'road',
    feature: 'majorroad',
    settings: ['an arterial road', 'a highway', 'the suburban street network', 'a freeway', 'an industrial estate'],
    pursuit: {
      vehicle: 'car',
      behaviour: 'flee',
      profile: 'car',
      mins: [5, 10],
      label: [
        'Stolen sedan — 3 POB',
        'Vehicle of interest — failed to stop',
        'Stolen hatch — driver only',
        'Pursuit vehicle — 2 POB, both masked',
        'Stolen dual-cab — 4 POB',
      ],
    },
    brief: [
      'Vehicle failed to stop, ground pursuit running.',
      'Stolen vehicle running from a breath test site.',
      'Armed robbery offenders decamping by car.',
      'Pursuit terminated by ground units — air wing to retain the eye.',
    ],
    detail: (c) =>
      `Ground units are pursuing a vehicle near ${c.loc}.${c.roads ? ` Running ${c.roads}.` : ''} ` +
      `Take the EYE so the road units can back off — call the running commentary, street names and direction of travel, ` +
      `and keep the cordon and the dog unit ahead of it. Stay with it until it stops or is abandoned.`,
    complications: [
      'Ground units have been told to withdraw — the eye is yours alone.',
      'The vehicle is driving on the wrong side; do not encourage the speed.',
      'Stop sticks are being deployed ahead — call the vehicle onto them.',
    ],
    hazards: ['Powerlines and towers over the arterial, other aircraft', 'Built-up area, noise abatement, low light'],
    persons: ['2–4 offenders in the vehicle; no injuries reported yet'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base once the vehicle is stopped and offenders are in custody'],
  },
  {
    kind: 'Stolen Vehicle — Covert Shadow',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    weight: 2,
    p1: 0.25,
    p2: 0.55,
    anchorKinds: ['metro', 'regional'],
    terrain: 'road',
    feature: 'majorroad',
    settings: ['an arterial road', 'a shopping centre car park', 'a residential area', 'an industrial estate'],
    pursuit: {
      vehicle: 'car',
      behaviour: 'cruise',
      profile: 'car',
      mins: [8, 14],
      label: [
        'ANPR hit — stolen sedan',
        'Vehicle of interest — target of a warrant',
        'Suspect vehicle — no pursuit authorised',
        'Stolen wagon — linked to a series',
      ],
    },
    brief: [
      'ANPR hit on a stolen vehicle — shadow only, no pursuit.',
      'Target vehicle under surveillance, ground crews need an eye.',
      'Suspect vehicle linked to a burglary series — follow it home.',
    ],
    detail: (c) =>
      `Plain-clothes crews are following a vehicle of interest near ${c.loc}.${c.roads ? ` Its route runs ${c.roads}.` : ''} ` +
      `Stay HIGH and wide — the occupants must not know you are there. No pursuit is authorised. ` +
      `Call the route so the ground crews can leapfrog, and hold the eye until it stops at an address.`,
    complications: [
      'The occupants are counter-surveillance conscious — vary your position.',
      'Surveillance crews have lost it twice already; do not lose it a third time.',
      'Do not overfly it directly — keep the offset.',
    ],
    hazards: ['Controlled airspace, keep the clearance', 'Built-up area, noise complaints if you sit low'],
    persons: ['2 occupants; both known to police'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Siege / Critical Incident Overwatch',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.65,
    p2: 0.3,
    anchorKinds: ['metro', 'regional'],
    terrain: 'urban',
    settings: ['a residential area', 'a suburban street', 'the town centre', 'an industrial estate'],
    brief: [
      'Armed offender barricaded in a house.',
      'Siege declared, exclusion zone in place.',
      'Critical incident — offender armed with a firearm.',
    ],
    detail: (c) =>
      `A critical incident is running at ${c.loc}. An exclusion zone is in force and the forward command post is established. ` +
      `Hold an orbit OUTSIDE the zone and provide overwatch of the rear yards and escape routes — the ground commander cannot see them. ` +
      `Downlink to the command post if fitted, and report any movement immediately.`,
    complications: [
      'Media helicopters are in the area — deconflict on the incident frequency.',
      'The negotiator is on the line; keep noise off the address.',
      'The exclusion zone has just been widened — reposition.',
    ],
    hazards: ['Offender is armed — stay high and out of line of sight', 'Media aircraft, powerlines, built-up area'],
    persons: ['1 armed offender; unknown number of persons inside'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base or the forward staging area'],
  },
  {
    kind: 'Tactical Insertion — Police Specialist Group',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.5,
    p2: 0.4,
    anchorKinds: ['metro', 'regional', 'remote'],
    terrain: 'rural',
    settings: ['a rural property', 'a homestead', 'a bushland block', 'a shed complex', 'a remote holding'],
    brief: [
      'Insert a tactical team for a high-risk warrant.',
      'Specialist group to be placed on a rural property at first light.',
      'Rope insertion for a high-risk arrest.',
    ],
    detail: (c) =>
      `The specialist response group requires insertion near ${c.loc} for a high-risk entry. ` +
      `Approach from the far side of the ridge and stay masked until the call — surprise is the plan. ` +
      `Set down or rope the team at the marked point, lift immediately, then hold overwatch clear of the property.`,
    complications: [
      'Dogs on the property will announce you — the run-in has to be quick.',
      'The entry has been delayed; hold at the holding point until called.',
      'Team wants a second lift for the exhibits once the scene is safe.',
    ],
    hazards: ['Unknown firearms on the property, dogs', 'Wires between the sheds, stock in the paddock, dust on landing'],
    persons: ['Tactical team of 6 + equipment'],
    access: ['N/A — insertion; ground units hold at the perimeter'],
    lz: ['Paddock short of the homestead, marked by the team'],
  },
  {
    kind: 'Traffic Operations — Aerial Enforcement',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.05,
    p2: 0.35,
    anchorKinds: ['metro', 'regional'],
    terrain: 'road',
    feature: 'majorroad',
    settings: ['a highway', 'a freeway', 'an arterial road', 'a notorious stretch of rural highway'],
    brief: [
      'Aerial speed and behaviour enforcement over the holiday operation.',
      'Highway operation — air support for the road policing units.',
      'Hoon operation over the arterial network.',
    ],
    detail: (c) =>
      `Road policing is running an operation over ${c.loc}. Track vehicles between the marked points, time them, ` +
      `and call offenders onto the intercept crews waiting downstream. Expect a long, boring orbit — and one genuine runner.`,
    complications: [
      'One vehicle has just taken off from the intercept point — take the eye.',
      'The intercept crew has gone to another job; hold the observation.',
    ],
    hazards: ['Long orbit — watch the fuel and the fatigue', 'Other traffic in the lane, towers on the ridge'],
    persons: ['N/A — observation and coordination'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Public Order — Crowd and Protest Monitoring',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.15,
    p2: 0.5,
    anchorKinds: ['metro'],
    terrain: 'urban',
    settings: ['the town centre', 'a residential area', 'an industrial estate', 'a parkland reserve'],
    brief: [
      'Large protest march moving through the CBD.',
      'Crowd monitoring for a planned demonstration.',
      'Two opposing groups converging on the same square.',
    ],
    detail: (c) =>
      `Public order command requests an aerial picture over ${c.loc}. Report crowd size, direction of movement and ` +
      `where the front of the march actually is — the ground commander is working blind between the buildings. ` +
      `Stay high enough that you are not the story.`,
    complications: [
      'A splinter group has broken away down a side street — follow it.',
      'Media aircraft on scene; deconflict and keep your separation.',
      'Command wants a crowd estimate for the next situation report.',
    ],
    hazards: ['CBD airspace, tall buildings, media aircraft', 'Noise — stay high, you are being filmed'],
    persons: ['N/A — crowd estimated in the thousands'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Major Event Overwatch',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.05,
    p2: 0.4,
    anchorKinds: ['metro', 'regional'],
    terrain: 'urban',
    settings: ['the town centre', 'a parkland reserve', 'a showground', 'a sports precinct'],
    brief: [
      'Air support for a major sporting event.',
      'Overwatch for a race meeting and the traffic around it.',
      'Event overwatch — crowd egress after the main event.',
    ],
    detail: (c) =>
      `Event command requests overwatch of ${c.loc}. Monitor the crowd, the car parks and the arterial egress, ` +
      `and give command early warning of any crush or blockage. A designated orbit and altitude will be allocated on arrival.`,
    complications: [
      'A fight has broken out in the eastern car park — get the eye on it.',
      'Egress has jammed on the main road; command wants options.',
      'A drone has been reported over the crowd — look for the operator.',
    ],
    hazards: ['Temporary restricted airspace over the venue, other aircraft', 'Drones around the crowd, fireworks after the event'],
    persons: ['N/A — crowd of tens of thousands'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Dignitary Route Overwatch',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [...POLICE_AGENCIES, ['ACT Policing (AFP)', 'PolAir']],
    p1: 0.35,
    p2: 0.5,
    anchorKinds: ['metro'],
    terrain: 'road',
    feature: 'majorroad',
    settings: ['an arterial road', 'the town centre', 'a freeway'],
    brief: [
      'Motorcade route overwatch for a visiting dignitary.',
      'Protective operation — air support for the route.',
      'Route reconnaissance ahead of a protected person movement.',
    ],
    detail: (c) =>
      `A protected person is moving by road through ${c.loc}. Fly the route ahead of the motorcade, ` +
      `report blockages, stopped vehicles on the overpasses and anything on the route that should not be there. ` +
      `Stay ahead of the convoy, not over it.`,
    complications: [
      'The route has been changed — the alternate runs through the CBD.',
      'A vehicle is parked on the overpass ahead; get a look at it.',
      'The move has been brought forward by twenty minutes.',
    ],
    hazards: ['Controlled airspace and CBD towers', 'Other aircraft, media interest in the movement'],
    persons: ['N/A — protective operation'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Club Run — Convoy Monitoring',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.2,
    p2: 0.55,
    anchorKinds: ['metro', 'regional'],
    terrain: 'road',
    feature: 'majorroad',
    settings: ['a highway', 'an arterial road', 'a rural arterial road'],
    pursuit: {
      vehicle: 'bike',
      behaviour: 'cruise',
      profile: 'bike',
      mins: [9, 15],
      convoy: [4, 9],
      label: ['Club run — motorcycle convoy', 'Outlaw club run — riders in formation', 'Monitored convoy — motorcycles'],
    },
    brief: [
      'Outlaw motorcycle club run moving between chapters.',
      'Monitored convoy — intelligence wants the route and the numbers.',
      'Club run heading for a rival chapter clubhouse.',
    ],
    detail: (c) =>
      `A monitored motorcycle convoy is on the move near ${c.loc}.${c.roads ? ` It is running ${c.roads}.` : ''} ` +
      `Hold the eye and count the riders, call the route, and warn the intercept crews before it reaches the next town. ` +
      `Do not spook it — this is intelligence gathering, not an interception.`,
    complications: [
      'Riders are splitting into two groups at the next junction — call it.',
      'Intelligence wants a count and a photograph of the lead group.',
      'A rival convoy is reported inbound on the same road.',
    ],
    hazards: ['Long tasking along a highway corridor, towers on the ridges', 'Other traffic, fuel planning for the distance'],
    persons: ['N/A — convoy of riders, numbers to be confirmed'],
    access: ['N/A — airborne task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Rural Crime — Stock Theft Patrol',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.05,
    p2: 0.35,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    settings: ['a cattle station', 'a rural property', 'a homestead', 'a network of fire trails', 'a paddock'],
    brief: [
      'Stock theft — a truckload of cattle taken overnight.',
      'Rural crime patrol over properties hit in a series.',
      'Report of an unfamiliar truck loading stock at night.',
    ],
    detail: (c) =>
      `Rural crime investigators request an aerial patrol over ${c.loc}. Check the back gates, the loading ramps and ` +
      `the tracks out to the boundary for fresh vehicle movement, and photograph anything worth a ground follow-up. ` +
      `The property runs to the horizon; the ground units cannot cover it.`,
    complications: [
      'A truck has just been spotted on the boundary track — get across to it.',
      'Fresh tyre marks at the far gate; the owner wants them photographed.',
    ],
    hazards: ['Wires between the sheds and across the gullies, stock', 'Remote area, long tasking, marginal fuel'],
    persons: ['N/A — patrol; property owner on the ground'],
    access: ['Station track from the highway'],
    lz: ['Paddock near the homestead, owner to mark'],
  },
  {
    kind: 'Trail Bikes — Reserve Patrol',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [...POLICE_AGENCIES, ...PARKS_AGENCIES],
    p1: 0.1,
    p2: 0.45,
    anchorKinds: ['regional', 'metro'],
    terrain: 'bush',
    settings: ['a bushland reserve', 'a state forest', 'a network of fire trails', 'a parkland reserve'],
    pursuit: {
      vehicle: 'bike',
      behaviour: 'flee',
      profile: 'bike',
      mins: [5, 9],
      convoy: [2, 4],
      label: ['Unregistered trail bikes — riders decamping', 'Trail bikes — failed to stop', 'Illegal riders in the reserve'],
    },
    brief: [
      'Unregistered trail bikes tearing up a reserve.',
      'Riders failed to stop for a ranger and took to the trails.',
      'Repeat offenders back in the reserve after a closure.',
    ],
    detail: (c) =>
      `Riders on unregistered bikes are in the reserve near ${c.loc}.${c.roads ? ` They have come out onto ${c.roads}.` : ''} ` +
      `Ground units cannot follow them on the trails. Hold the eye, call which trail they take, and put the units on the ` +
      `exit they are heading for — they will be caught at the gate, not in the bush.`,
    complications: [
      'The riders have split up at the trail junction — stay with the lead bike.',
      'One rider has come off; check whether an ambulance is needed.',
    ],
    hazards: ['Rising terrain, wires across the valleys, dust', 'Dense canopy — you will lose them under the trees'],
    persons: ['2–4 riders; no injuries reported'],
    access: ['N/A — airborne task; ground units at the reserve gates'],
    lz: ['Trailhead car park or the reserve gate'],
  },
  {
    kind: 'Cannabis Crop — Aerial Detection',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.05,
    p2: 0.4,
    anchorKinds: ['regional', 'remote'],
    terrain: 'bush',
    settings: ['a state forest', 'a bushland block', 'a network of fire trails', 'scrub near a walking track', 'a forestry block'],
    brief: [
      'Aerial detection run over known growing country.',
      'Informant report of a crop in the state forest.',
      'Crop eradication — locate the sites for the ground teams.',
    ],
    detail: (c) =>
      `Drug investigators request a detection run over ${c.loc}. Fly the creek lines and the clearings, ` +
      `look for irrigation line, fresh clearing and vehicle tracks that end nowhere, and mark any site for the ground teams. ` +
      `Do not overfly a site twice — a second pass tells them you have seen it.`,
    complications: [
      'A vehicle has just left a track near the suspected site.',
      'Ground teams want coordinates for the closest vehicle access.',
      'A second clearing is visible further up the creek.',
    ],
    hazards: ['Rising terrain and wires across the gullies', 'Crop sites are sometimes guarded — do not get low'],
    persons: ['N/A — detection task; ground teams standing by'],
    access: ['N/A — search sectors'],
    lz: ['Staging area at the forest entrance'],
  },
  {
    kind: 'Escapee — Manhunt Containment',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.7,
    p2: 0.25,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    settings: ['a rural property', 'a bushland reserve', 'a network of fire trails', 'a paddock', 'a roadhouse'],
    brief: [
      'Escapee from a correctional facility, believed on foot.',
      'Offender absconded from an escort at a country hospital.',
      'Manhunt — offender ran from a stolen car into scrub.',
    ],
    detail: (c) =>
      `A manhunt is running near ${c.loc}. The cordon is being established but there are too many gaps to hold on the ground. ` +
      `Work the scrub, the creek lines and the sheds inside the cordon with FLIR if fitted, and put the dog unit onto any find. ` +
      `The offender is considered dangerous — do not put crew on the ground.`,
    complications: [
      'A heat source has been reported in the treeline — confirm it.',
      'A property owner has reported a shed broken into inside the cordon.',
      'The cordon is being pulled in; the search area is now much smaller.',
    ],
    hazards: ['Offender considered dangerous, possibly armed', 'Rising terrain, wires, fading light on a long tasking'],
    persons: ['1 escapee; ~40 police on the cordon'],
    access: ['N/A — airborne task'],
    lz: ['Staging area at the forward command post'],
  },
  {
    kind: 'Remote Community — Police Response Support',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: POLICE_AGENCIES,
    p1: 0.45,
    p2: 0.45,
    anchorKinds: ['remote'],
    terrain: 'rural',
    settings: ['an outstation', 'a remote roadhouse', 'a cattle station', 'a remote holding'],
    brief: [
      'Serious assault in a remote community, two officers on the ground.',
      'Police at a remote community request urgent support.',
      'Disturbance in a remote community, nearest backup is hours by road.',
    ],
    detail: (c) =>
      `The two-officer station at ${c.loc} has requested support — the nearest backup is hours away by road. ` +
      `Carry the additional members in, hold overwatch while the situation is stabilised, and be prepared to take a ` +
      `person out if the road is cut. Coordinate with the community police liaison on arrival.`,
    complications: [
      'The airstrip is unserviceable — the oval is the alternative.',
      'A person has been injured and may need to come out with you.',
      'The road in is cut; you are the only way in or out today.',
    ],
    hazards: ['Remote, long tasking, marginal fuel and no refuelling', 'Dust on landing, stock and dogs on the strip'],
    persons: ['2 local officers + 4 members to be carried in'],
    access: ['Community airstrip or the oval'],
    lz: ['Community airstrip, or the oval with the local officer to mark'],
  },
  {
    kind: 'Vessel of Interest — Maritime Surveillance',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: MARITIME_AGENCIES,
    weight: 2,
    p1: 0.4,
    p2: 0.5,
    offshore: true,
    anchorKinds: ['coastal'],
    terrain: 'offshore',
    settings: [],
    pursuit: {
      vehicle: 'boat',
      behaviour: 'cruise',
      mins: [9, 16],
      label: [
        'Vessel of interest — inbound, no AIS',
        'Suspect vessel — met a yacht offshore overnight',
        'Unidentified vessel — running without lights',
        'Vessel of interest — rendezvous suspected',
      ],
    },
    brief: [
      'Unidentified vessel inbound, no AIS, running dark.',
      'Suspected importation — vessel met another craft offshore.',
      'Vessel of interest tracking toward an isolated beach.',
    ],
    detail: (c) =>
      `A vessel of interest is tracking off ${c.town}. Water police are launching but are well behind it. ` +
      `Hold the eye, record its heading and speed, identify the hull and any name or number, and call where it makes landfall. ` +
      `Stay off it — an obvious overflight and it will dump whatever it is carrying.`,
    complications: [
      'The vessel has altered course — it knows something is up.',
      'A second small craft has come out to meet it.',
      'Water police want a vector to intercept before it reaches the bar.',
    ],
    hazards: ['Overwater, swell and spray, salt on the windscreen', 'Fading light, long way from the coast — watch the fuel'],
    persons: ['2–4 persons aboard, unknown'],
    access: ['N/A — overwater task'],
    lz: ['Recovery to base or the coastal refuelling point'],
  },
  {
    kind: 'Stolen Vessel — Coastal Search',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [...POLICE_AGENCIES, ['Marine Rescue', 'Marine Rescue']],
    p1: 0.25,
    p2: 0.5,
    anchorKinds: ['coastal'],
    terrain: 'coast',
    settings: ['a boat ramp', 'a resort marina', 'a beach access point', 'a dive charter jetty'],
    brief: [
      'Vessel stolen from a marina overnight.',
      'Jet skis taken from a boat ramp, last seen heading north.',
      'Stolen runabout believed to be running the inshore line.',
    ],
    detail: (c) =>
      `A vessel was taken from ${c.loc} overnight. Water police want the inshore line, the river mouths and the creeks ` +
      `searched before it is stripped and dumped. Check the moorings and the sand bars — most are found abandoned within a few miles.`,
    complications: [
      'A hull matching the description has been reported in a creek mouth.',
      'The owner is on the radio and can identify the vessel by its canopy.',
    ],
    hazards: ['Low-level overwater and over-beach flying, birds', 'Coastal turbulence, glare off the water'],
    persons: ['N/A — vessel search; offenders may be aboard'],
    access: ['N/A — search sectors along the coast'],
    lz: ['Foreshore reserve or the boat ramp car park'],
  },
  {
    kind: 'Illegal Fishing — Aerial Patrol',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: MARITIME_AGENCIES,
    p1: 0.05,
    p2: 0.4,
    offshore: true,
    anchorKinds: ['coastal'],
    terrain: 'offshore',
    settings: [],
    brief: [
      'Illegal netting reported inside a marine park.',
      'Foreign fishing vessel reported inside the zone.',
      'Compliance patrol over the closed waters.',
    ],
    detail: (c) =>
      `Fisheries compliance requests a patrol over the closed waters off ${c.town}. Photograph any vessel working inside the ` +
      `boundary, record its name, hull number and gear in the water, and pass the position to the patrol boat. ` +
      `Your photographs are the evidence — get them right the first time.`,
    complications: [
      'A vessel is hauling gear right now — get the photographs before it is aboard.',
      'The patrol boat is two hours away and wants a track on the vessel.',
    ],
    hazards: ['Overwater, well offshore — fuel and flotation', 'Swell, glare, no diversion within range'],
    persons: ['N/A — compliance patrol'],
    access: ['N/A — overwater task'],
    lz: ['Recovery to base'],
  },
  {
    kind: 'Marine Rescue — Winch',
    toDefinitiveCare: true,
    alwaysTransports: true,
    category: 'Marine / SAR',
    cls: 'rotary',
    agencies: [['Westpac Life Saver Rescue', 'Lifesaver'], ['Marine Rescue', 'Marine Rescue'], ['AMSA / JRCC Australia', 'Rescue']],
    weight: 2,
    p1: 0.7,
    p2: 0.3,
    offshore: true,
    transport: true,
    anchorKinds: ['coastal'],
    terrain: 'offshore',
    cas: 'marine',
    settings: [],
    brief: ['Vessel disabled offshore, injured person aboard.', 'Person overboard, recovered by a nearby yacht.', 'Diver surfaced unwell after a deep dive.'],
    detail: (c) =>
      `A vessel in difficulty offshore from ${c.town} with an injured person aboard. Marine Rescue is en route by sea. Winch the casualty and transport to ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Swell, spray, salt on the windscreen', 'Rigging and aerials, reducing light'],
    persons: ['4 POB, lifejackets worn, 1 injured', '1 diver, ? decompression illness'],
    access: ['N/A — overwater winch to a moving deck'],
    lz: ['N/A — overwater; transfer ashore at the nearest hospital'],
  },
  {
    kind: 'Diving Incident — Decompression Illness',
    toDefinitiveCare: true,
    category: 'Aeromedical',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.6,
    p2: 0.35,
    transport: true,
    anchorKinds: ['coastal'],
    terrain: 'coast',
    cas: 'marine',
    settings: ['a dive charter jetty', 'a boat ramp', 'a resort marina', 'a beach access point'],
    brief: ['Diver with joint pain and pins-and-needles after a deep dive.', 'Rapid ascent, chest pain and confusion.'],
    detail: (c) =>
      `A diver at ${c.loc} has symptoms of decompression illness. Fly LOW (max 1000 ft AGL, cabin unpressurised) and transport on oxygen to a recompression facility — coordinate the receiving chamber with ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Altitude restriction — plan a low, smooth profile', 'Coastal turbulence, marine layer'],
    persons: ['1 patient on oxygen + a dive buddy as escort'],
    access: ['Vehicle access to the jetty; ground crew waiting'],
    lz: ['Car park or foreshore reserve, keep it low and gentle'],
  },
  {
    kind: 'Envenomation — Remote',
    toDefinitiveCare: true,
    category: 'Aeromedical',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.75,
    p2: 0.25,
    transport: true,
    anchorKinds: ['remote', 'regional'],
    terrain: 'rural',
    cas: 'medical',
    settings: ['a cattle station', 'a remote roadhouse', 'a mine camp', 'an outstation', 'a bore run'],
    brief: ['Snakebite, collapse, ? coagulopathy.', 'Bee-sting anaphylaxis, remote, adrenaline given.', 'Marine sting, severe pain and hypertension.'],
    detail: (c) =>
      `A patient at ${c.loc} has been bitten/stung and is deteriorating. Antivenom stock is limited locally. Retrieval requested for ${c.hospital ?? `${c.town} hospital`}; keep the limb still and the patient flat.`,
    hazards: ['Remote, long tasking, marginal fuel', 'Rough strip / paddock, stock, no lighting'],
    persons: ['1 patient + a first-aider'],
    access: ['Station track to the homestead'],
    lz: ['Airstrip or a graded paddock, owner to mark'],
  },
  {
    kind: 'Powerline Strike / Electrocution',
    toDefinitiveCare: true,
    feature: 'majorroad',
    category: 'HEMS / trauma',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.7,
    p2: 0.3,
    transport: true,
    anchorKinds: ['regional', 'remote'],
    terrain: 'rural',
    cas: 'burns',
    settings: ['a construction site', 'a farm with an irrigator', 'a roadside with a crane', 'a rail maintenance site'],
    brief: ['Worker contacted overhead HV lines from a tipper.', 'Irrigator into powerlines, operator down.'],
    detail: (c) =>
      `Electrical contact incident at ${c.loc}. Power is being isolated by the network operator — do NOT approach until confirmed dead. One patient with entry/exit burns and arrhythmia for ${c.hospital ?? `${c.town} hospital`}.`,
    hazards: ['Live or re-closing HV lines, step potential, arcing', 'Damaged plant, unstable load'],
    persons: ['1 serious (burns + cardiac), workmates shocked'],
    access: ['Site access once the network operator confirms isolation'],
    lz: ['Well clear of the lines, upwind, ground party to mark'],
  },
  {
    kind: 'Fire Reconnaissance / Crew Insertion',
    category: 'Firefighting support',
    cls: 'rotary',
    agencies: [...FIRE_AGENCIES, ...PARKS_AGENCIES],
    weight: 2,
    p1: 0.3,
    p2: 0.5,
    anchorKinds: ['regional', 'remote'],
    terrain: 'bush',
    settings: ['a state forest', 'a national park', 'a forested ridge', 'timbered country', 'a bushland reserve', 'a forestry block'],
    brief: ['Insert a remote area crew to a ridge.', 'Line-scan the active flank.', 'Air attack supervision over a new start.'],
    detail: (c) =>
      `Incident control requests a helicopter over the fire ground in ${c.loc}. Expect smoke, reduced visibility and other aircraft on the fire ground frequency.`,
    hazards: ['Dense smoke, other firebombing aircraft, terrain', 'Turbulence and downdrafts near the fire'],
    persons: ['Remote area crew of 4 + equipment'],
    access: ['N/A — winch / hover exit'],
    lz: ['Ridge-top hover exit, marked by the crew'],
  },
  {
    kind: 'Storm Damage — SES Air Support',
    category: 'Firefighting support',
    cls: 'rotary',
    agencies: [...POLICE_AGENCIES, ...FIRE_AGENCIES, ...PARKS_AGENCIES],
    p1: 0.15,
    p2: 0.45,
    anchorKinds: ['regional', 'coastal'],
    terrain: 'rural',
    settings: ['a storm-damage corridor', 'a hail swathe through farmland', 'a flash-flood catchment', 'a town after a supercell'],
    brief: ['Aerial damage assessment after a severe storm.', 'Locate isolated properties after flash flooding.', 'Check the state of key roads and bridges.'],
    detail: (c) =>
      `SES requests an aerial assessment over ${c.loc} following severe weather. Photograph damage, identify isolated or cut-off properties, and report road and bridge status back to the incident controller.`,
    hazards: ['Debris and downed wires everywhere, other aircraft', 'Residual turbulence, poor light under cloud'],
    persons: ['N/A — assessment; note any persons needing help'],
    access: ['N/A — task area'],
    lz: ['Recovery to the staging area'],
  },
  {
    kind: 'RFDS Primary Evacuation',
    toDefinitiveCare: true,
    alwaysTransports: true,
    category: 'Aeromedical (fixed wing)',
    cls: 'fixed',
    agencies: [['Royal Flying Doctor Service', 'Flying Doctor']],
    weight: 2,
    p1: 0.65,
    p2: 0.3,
    transport: true,
    anchorKinds: ['remote', 'regional'],
    terrain: 'airstrip',
    cas: 'medical',
    settings: ['the community airstrip', 'a station airstrip', 'the clinic airstrip', 'a gravel airstrip', 'a mine-site aerodrome'],
    brief: ['Acute abdomen at a remote clinic.', 'Serious farm injury, strip lit on request.', 'Chest pain at a mine camp, thrombolysis unavailable.'],
    detail: (c) =>
      `A patient at ${c.loc} requires aeromedical evacuation${c.hospital ? ` to ${c.hospital}` : ` to ${c.town} Base Hospital`}. Local strip is gravel, ~1200 m; clinic staff will meet the aircraft. Watch for stock on the strip.`,
    hazards: ['Kangaroos and stock on the strip, no lighting, remote', 'Dust on landing, crosswind'],
    persons: ['1 patient + escort'],
    access: ['Station / community airstrip'],
    lz: ['Unsealed strip — inspect on a low pass'],
  },
  {
    kind: 'Neonatal / Paediatric Retrieval',
    toDefinitiveCare: true,
    alwaysTransports: true,
    fromHospital: true,
    category: 'Critical care transfer',
    cls: 'fixed',
    agencies: [['NSW Air Ambulance', 'Ambulance'], ['Ambulance Victoria', 'Ambulance'], ['Royal Flying Doctor Service', 'Flying Doctor']],
    p1: 0.85,
    p2: 0.15,
    transport: true,
    anchorKinds: ['regional'],
    terrain: 'airstrip',
    cas: 'paeds',
    settings: ['the regional airport', 'the base hospital airport', 'the town aerodrome'],
    brief: ['Sick newborn for a tertiary NICU.', 'Child with a severe head injury for a paediatric ICU.', 'Ventilated infant, bronchiolitis, deteriorating.'],
    detail: (c) =>
      `The retrieval team needs transport from ${c.loc}${c.hospital ? ` to ${c.hospital}` : ` to the tertiary centre`}. Incubator/PICU kit aboard — expect extra weight and a longer scene time at the referring hospital.`,
    hazards: ['Long tasking, night arrival, weather en route', 'Time-critical — every minute counts'],
    persons: ['1 infant/child + retrieval team + one parent'],
    access: ['Regional airport, ambulance airside both ends'],
    lz: ['Sealed runway'],
  },
  {
    kind: 'Obstetric Flying Squad',
    toDefinitiveCare: true,
    alwaysTransports: true,
    category: 'Critical care transfer',
    cls: 'fixed',
    agencies: [['Royal Flying Doctor Service', 'Flying Doctor'], ['NSW Air Ambulance', 'Ambulance']],
    p1: 0.7,
    p2: 0.3,
    transport: true,
    anchorKinds: ['remote', 'regional'],
    terrain: 'airstrip',
    cas: 'obs',
    settings: ['the community airstrip', 'the town aerodrome', 'a station airstrip'],
    brief: ['Antepartum haemorrhage, no local obstetric cover.', 'Preterm labour at 30 weeks, needs a level-3 nursery.', 'Severe pre-eclampsia for urgent transfer.'],
    detail: (c) =>
      `An obstetric patient at ${c.loc} needs urgent transfer${c.hospital ? ` to ${c.hospital}` : ` to a maternity unit`}. Plan for the possibility of delivery in flight; midwife and neonatal kit aboard.`,
    hazards: ['Time-critical, potential in-flight delivery', 'Night, weather, marginal strip'],
    persons: ['1 patient + midwife + support person'],
    access: ['Airstrip, ambulance to meet'],
    lz: ['Unsealed or sealed strip depending on the site'],
  },
  {
    kind: 'Burns — Inter-Hospital Transfer',
    toDefinitiveCare: true,
    alwaysTransports: true,
    fromHospital: true,
    category: 'Critical care transfer',
    cls: 'fixed',
    agencies: [['Royal Flying Doctor Service', 'Flying Doctor'], ['Ambulance Victoria', 'Ambulance'], ['NSW Air Ambulance', 'Ambulance']],
    p1: 0.7,
    p2: 0.3,
    transport: true,
    anchorKinds: ['regional'],
    terrain: 'airstrip',
    cas: 'burns',
    settings: ['the regional airport', 'the base hospital airport'],
    brief: ['Major burns patient for the state burns unit.', 'Airway burns, intubated, for a tertiary centre.'],
    detail: (c) =>
      `Bed-to-bed transfer of a major burns patient from ${c.loc}${c.hospital ? ` to ${c.hospital}` : ` to the burns unit`}. Warm cabin, fluid-resuscitation ongoing, plan a smooth IFR profile.`,
    hazards: ['Long tasking, temperature management, weather en route', 'Fluid shifts — the patient may deteriorate in flight'],
    persons: ['1 patient (intubated) + retrieval team'],
    access: ['Regional airport, ambulance airside'],
    lz: ['Sealed runway'],
  },
  {
    kind: 'Inter-Hospital Transfer (Rotary)',
    toDefinitiveCare: true,
    alwaysTransports: true,
    fromHospital: true,
    category: 'Critical care transfer',
    cls: 'rotary',
    agencies: HEMS_AGENCIES,
    p1: 0.55,
    p2: 0.4,
    weight: 2,
    transport: true,
    anchorKinds: ['regional', 'remote'],
    terrain: 'urban',
    cas: 'medical',
    settings: [],
    brief: [
      'District hospital has a patient beyond their capability — needs a tertiary centre.',
      'Time-critical transfer, receiving unit is standing by.',
    ],
    detail: (c) =>
      `Bed-to-bed transfer from ${c.loc}${c.hospital ? ` to ${c.hospital}` : ' to a tertiary centre'}. ` +
      `The referring team will have the patient packaged on the pad; expect a short turnaround and a retrieval doctor on board.`,
    hazards: [
      'Confined hospital helipad, obstacles and rooftop turbulence',
      'Patient may deteriorate in flight — plan a diversion',
      'Night pad, limited lighting',
    ],
    persons: ['1 patient + referring team'],
    access: ['Hospital helipad, ambulance on the pad'],
    lz: ['Hospital helipad — confined, watch the approach path'],
  },
  {
    kind: 'Inter-Hospital Transfer (Fixed Wing)',
    toDefinitiveCare: true,
    alwaysTransports: true,
    fromHospital: true,
    category: 'Critical care transfer',
    cls: 'fixed',
    agencies: [['Royal Flying Doctor Service', 'Flying Doctor'], ['Ambulance Victoria', 'Ambulance'], ['NSW Air Ambulance', 'Ambulance']],
    weight: 2,
    p1: 0.4,
    p2: 0.5,
    transport: true,
    anchorKinds: ['regional'],
    terrain: 'airstrip',
    cas: 'medical',
    settings: ['the regional airport', 'the town aerodrome', 'the base hospital airport'],
    brief: ['Ventilated ICU patient for a tertiary centre.', 'STEMI for the cath lab, no local PCI.', 'Large-vessel stroke for thrombectomy.'],
    detail: (c) =>
      `Bed-to-bed transfer of a critical patient from ${c.loc}${c.hospital ? ` to ${c.hospital}` : ` out of ${c.town}`}. Road ambulance both ends. Plan an IFR arrival.`,
    hazards: ['Weather en route, night arrival', 'Long tasking'],
    persons: ['1 patient + retrieval team + escort'],
    access: ['Regional airport, ambulance airside'],
    lz: ['Sealed runway'],
  },
  {
    kind: 'Search and Rescue — Offshore',
    category: 'SAR',
    cls: 'fixed',
    agencies: [['AMSA / JRCC Australia', 'Rescue'], ['JRCC Australia', 'Rescue']],
    weight: 2,
    p1: 0.7,
    p2: 0.3,
    offshore: true,
    anchorKinds: ['coastal'],
    terrain: 'offshore',
    settings: [],
    brief: ['Overdue vessel, proceed to datum.', 'EPIRB activation offshore, no voice contact.', 'Ditched aircraft reported, souls unknown.'],
    detail: (c) =>
      `A distress beacon has activated offshore from ${c.town}. JRCC Australia coordinating. Reach the datum, run an expanding-square then a creeping-line search, drop a datum marker, and remain on scene until relieved.`,
    hazards: ['Sea state and swell, reducing light, night recovery likely', 'Other search aircraft, low-level fatigue'],
    persons: ['2–4 POB reported', 'Souls on board unknown'],
    access: ['N/A — search area'],
    lz: ['Recovery to a coastal aerodrome'],
  },
  {
    kind: 'Fire Mapping / Air Attack Supervision',
    category: 'Firefighting (fixed wing)',
    cls: 'fixed',
    agencies: [...FIRE_AGENCIES, ['Aerial Survey Operations', 'Survey']],
    weight: 2,
    p1: 0.2,
    p2: 0.5,
    anchorKinds: ['regional', 'remote'],
    terrain: 'bush',
    settings: ['a forest complex', 'a national park', 'the ranges', 'a forestry district', 'timbered ranges'],
    brief: ['Line-scan the fire complex, downlink imagery.', 'Bird-dog for the air tankers.', 'Recon overnight lightning starts at first light.'],
    detail: (c) =>
      `State air desk requests a mapping / supervision sortie over the fire complex in ${c.loc}. Heavy traffic on the fire ground and smoke to several thousand feet — set up the pattern and take control of the airspace block.`,
    hazards: ['Smoke, poor visibility, mountainous terrain, multiple aircraft', 'Turbulence, density altitude'],
    persons: ['N/A — mapping / supervision'],
    access: ['N/A — task area'],
    lz: ['Recovery to the air tanker base'],
  },
  {
    kind: 'Maritime Surveillance Patrol',
    category: 'Border / fisheries',
    cls: 'fixed',
    agencies: [['Australian Border Force', 'Border'], ['AMSA / JRCC Australia', 'Rescue']],
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    anchorKinds: ['coastal'],
    terrain: 'offshore',
    settings: [],
    brief: ['Patrol the surveillance box, report foreign fishing.', 'Investigate a contact of interest.', 'Pollution / oil sheen survey along the shipping lane.'],
    detail: (c) =>
      `Tasked to patrol a surveillance box offshore from ${c.town}. Log all contacts with position, course and speed; photograph anything of interest and stay outside 500 ft of vessels unless directed.`,
    hazards: ['Low-level over water, birds, fatigue', 'Weather building offshore'],
    persons: ['N/A — surveillance'],
    access: ['N/A — patrol area'],
    lz: ['Recovery to the surveillance base'],
  },
  {
    kind: 'Aerial Survey / Photography',
    category: 'Survey',
    cls: 'fixed',
    agencies: [['Aerial Survey Operations', 'Survey'], ...PARKS_AGENCIES],
    p1: 0.02,
    p2: 0.18,
    anchorKinds: ['regional', 'remote', 'coastal'],
    terrain: 'rural',
    settings: ['a survey block', 'a coastal erosion strip', 'a pipeline corridor', 'a catchment', 'a powerline easement'],
    brief: ['Fly the survey grid at height and speed for the sensor.', 'Photograph the coastline strip on a falling tide.', 'Pipeline / powerline inspection run.'],
    detail: (c) =>
      `Fly a precise survey pattern over ${c.loc}. Hold the programmed height, heading and ground speed on each line for the sensor; turn outside the block and re-establish before the next line.`,
    hazards: ['Repetitive low-level lines, other traffic, wires', 'Sun angle and cloud shadow limit the window'],
    persons: ['N/A — survey; sensor operator aboard'],
    access: ['N/A — survey block'],
    lz: ['Recovery to the survey base'],
  },
];

// ---- generate -----------------------------------------------------

/** Weighted random template pick. */
function pickTpl(list: Tpl[]): Tpl {
  const total = list.reduce((s, t) => s + (t.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const t of list) {
    r -= t.weight ?? 1;
    if (r <= 0) return t;
  }
  return list[list.length - 1]!;
}

function dms(lat: number, lon: number): string {
  const f = (v: number, p: string, n: string) => {
    const h = v >= 0 ? p : n;
    const a = Math.abs(v);
    const d = Math.floor(a);
    return `${d}°${((a - d) * 60).toFixed(1)}'${h}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

/**
 * Generate one job. If `near` is given, most jobs are placed at an anchor within
 * ~320 NM of that point (so operators see tasking they can actually reach); the
 * rest are national.
 */
export function generateJob(near?: { lat: number; lon: number } | null): Job {
  // Some templates cannot be placed credibly everywhere: a fixed-wing retrieval
  // needs an anchor 60 NM from definitive care, and a transfer needs somewhere
  // to transfer from. Rather than generate one anyway and end up with a
  // "retrieval" 9 NM from the Gold Coast, re-roll the template.
  for (let attempt = 0; attempt < 20; attempt++) {
    const job = buildJob(pickTpl(TEMPLATES), near, true);
    if (job) return job;
  }
  return buildJob(pickTpl(TEMPLATES), near, false)!;
}

function buildJob(
  tpl: (typeof TEMPLATES)[number],
  near: { lat: number; lon: number } | null | undefined,
  strict: boolean,
): Job | null {
  let pool = tpl.anchorKinds
    ? (tpl.offshore ? COASTAL : ANCHORS).filter((a) => tpl.anchorKinds!.includes(a.kind))
    : tpl.offshore
      ? COASTAL
      : ANCHORS;
  if (!pool.length) pool = ANCHORS;

  if (near && Math.random() < 0.9) {
    const local = pool.filter((a) => rngNm(near.lat, near.lon, a.lat, a.lon) <= 240);
    if (local.length) pool = local;
    else {
      const nearest = [...pool].sort(
        (a, b) => rngNm(near.lat, near.lon, a.lat, a.lon) - rngNm(near.lat, near.lon, b.lat, b.lon),
      );
      pool = nearest.slice(0, 1);
    }
  }
  // A template that needs a real feature (a rail crossing, a road) can only run
  // where one exists — otherwise you get a level crossing near Broome, which has
  // no railway at all.
  if (tpl.feature) {
    const able = pool.filter((a) => anchorHasFeature(a.name, tpl.feature));
    if (able.length) pool = able;
  }

  // An air asset only makes sense where definitive care is far away. In a
  // capital the road ambulance reaches the trauma centre in minutes and HEMS is
  // simply not tasked — so don't generate the job there at all, rather than
  // generating one and stripping its transport leg. This also stops a
  // "retrieval" being a 20 NM hop next door to a capital.
  // A transfer needs somewhere to transfer FROM, far enough out that the flight
  // is credible for THIS aircraft — a fixed-wing transfer needs 60 NM, not the
  // rotary 20.
  const clsMin = MIN_TRANSPORT_NM[tpl.cls] ?? 0;
  if (tpl.fromHospital) {
    const able = pool.filter((a) => referringHospital(a, clsMin) !== null);
    if (able.length) pool = able;
    else if (strict) return null;
  }

  if (tpl.transport && tpl.toDefinitiveCare) {
    const remote = pool.filter((a) => {
      const h = nearestHospital(a.lat, a.lon, true);
      return rngNm(a.lat, a.lon, h.lat, h.lon) >= clsMin;
    });
    if (remote.length) pool = remote;
    else if (strict) return null;
  }
  const anchor = rand(pool.length ? pool : ANCHORS);

  // Choose WHERE the job is by choosing WHAT it is on. Prefer settings this
  // anchor actually has a real feature for, so "a residential area near Sale"
  // lands among houses instead of on a random bearing in a paddock. If none of
  // the template's settings map to anything nearby, fall back to the old coarse
  // placement rather than dropping the job.
  const settingChoices = tpl.settings.length ? tpl.settings : [];
  const placeable = settingChoices.filter((s) => {
    const k = featureForSetting(s);
    return k ? anchorHasFeature(anchor.name, k) : false;
  });
  const setting = placeable.length ? rand(placeable) : settingChoices.length ? rand(settingChoices) : anchor.name;
  // Only a real template setting picks the feature. Offshore and airstrip jobs
  // are positioned by their own rules, and when a template has no settings the
  // fallback is the TOWN name — which would match this table on a town called
  // Airlie Beach and put a "Search and Rescue — Offshore" job on the sand.
  const settingKind =
    settingChoices.length && tpl.terrain !== 'offshore' && tpl.terrain !== 'airstrip' ? featureForSetting(setting) : null;

  const spot =
    (settingKind && placeOnFeature(anchor, settingKind)) ||
    (tpl.feature && placeOnFeature(anchor, tpl.feature)) ||
    placePoint(anchor, tpl.terrain);
  let lat = spot.lat;
  let lon = spot.lon;
  // Airstrip jobs name a REAL aerodrome — "Newcastle Airport (YWLM)" rather than
  // "the town aerodrome at Newcastle" — and the job sits on that field, not on a
  // random bearing from the town.
  // A transfer starts on the referring hospital's helipad.
  const from = tpl.fromHospital ? referringHospital(anchor, clsMin) : null;
  // A bed-to-bed transfer starts at a bed. For rotary that is the referring
  // hospital's helipad; for fixed wing the aircraft cannot get to the bed, so
  // it departs the airport serving that hospital and the patient comes out by
  // road. Without this the departure end named no hospital at all — "bed-to-bed
  // transfer from RAAF Base East Sale" — while the arrival end named one.
  const departure = from && tpl.cls === 'fixed' ? airportFor(from.name) : null;
  if (from) {
    lat = departure ? departure.lat : from.lat;
    lon = departure ? departure.lon : from.lon;
  }
  // An airstrip job moves the scene to a real aerodrome, which can sit up to
  // 60 km from the anchor the credibility check was run against — enough to
  // land a "fixed-wing retrieval" 9 NM from the Gold Coast. Re-apply the floor
  // to the aerodrome itself and only use ones that still justify the flight.
  const aeroPool = !from && tpl.terrain === 'airstrip' ? (AERODROMES[anchor.name] ?? []) : [];
  const aeroOk = tpl.transport
    ? aeroPool.filter((a) => {
        const h = nearestHospital(a.lat, a.lon, tpl.toDefinitiveCare === true);
        return rngNm(a.lat, a.lon, h.lat, h.lon) >= clsMin;
      })
    : aeroPool;
  const aero = aeroOk.length ? rand(aeroOk) : null;

  // Agency is chosen for the region the job is really in: a transfer begins at
  // the referring hospital, which can be across a border from the anchor.
  const jobRegion = from?.region ?? anchor.region;
  const [agencyName] = pickAgency(tpl.agencies, jobRegion, anchor.name);
  const csTmpl = tpl.agencies.find((a) => a[0] === agencyName)?.[1] ?? 'Rescue';
  const callsign = callsignFor(agencyName, csTmpl);
  if (aero) {
    lat = aero.lat;
    lon = aero.lon;
  }
  let loc = from
    ? departure
      ? `${from.name} via ${departure.name} (${departure.icao})`
      : from.name
    : aero
    ? `${aero.name} (${aero.icao})`
    : tpl.terrain === 'offshore'
      ? anchor.name
      : tpl.terrain === 'airstrip'
        ? `${setting} at ${anchor.name}`
        : `${setting} near ${anchor.name}`;

  // A pursuit REPLACES the placement above: the job pin is where the run
  // starts, and the route is walked over the real road graph so the vehicle
  // takes actual intersections. An anchor with no harvested roads still runs
  // the job on a synthetic route rather than dropping the tasking.
  const groundTargets: GroundTarget[] = [];
  let pursuitRoads = '';
  if (tpl.pursuit) {
    const [lo, hi] = tpl.pursuit.mins ?? [6, 12];
    const wantMin = lo + Math.random() * (hi - lo);
    const boat = tpl.pursuit.vehicle === 'boat';
    // A vessel obviously does not use the road graph. It tracks PARALLEL to the
    // coast (the anchor's `sea` bearing, turned 90°) with gentle course
    // changes, so a 12 NM run doesn't put it up a beach.
    const route =
      (!boat && hasRoadGraph(anchor.name)
        ? pursuitRoute(anchor.name, { targetMin: wantMin, profile: tpl.pursuit.profile, near: { lat, lon } })
        : null) ??
      syntheticRoute(
        { lat, lon },
        boat
          ? {
              // a vessel doing ~45 km/h covers about 0.4 NM a minute
              targetNm: wantMin * 0.4,
              bearing: ((anchor.sea ?? 90) + (chance(0.5) ? 90 : 270)) % 360,
              turnMax: 30,
              speedKmh: [30, 62],
            }
          : { targetNm: wantMin * 0.9, profile: tpl.pursuit.profile },
      );
    const head = route.points[0]!;
    lat = head.lat;
    lon = head.lon;
    // Name the road the vehicle is actually on. The generic setting phrase was
    // picked before the route existed, so the brief read "near an arterial road
    // near Perth" for a run down the Tonkin Highway. The FIRST road goes into
    // the location, so the running commentary lists only what comes after it —
    // otherwise the brief named the same highway twice in two sentences.
    if (route.roads.length) {
      loc = `the ${route.roads[0]} at ${anchor.name}`;
      pursuitRoads = formatRoads(route.roads.slice(1));
    } else {
      pursuitRoads = formatRoads(route.roads);
    }
    const convoy = tpl.pursuit.convoy ? rint(tpl.pursuit.convoy[0], tpl.pursuit.convoy[1]) : undefined;
    groundTargets.push({
      label: rand(tpl.pursuit.label),
      vehicle: tpl.pursuit.vehicle,
      behaviour: tpl.pursuit.behaviour,
      // It must not run the whole route before you are airborne and overhead.
      holdUntilNm: tpl.pursuit.behaviour === 'flee' ? 8 : 12,
      convoy,
      rego: tpl.pursuit.vehicle === 'boat' ? undefined : plate(anchor.region),
      roads: route.roads,
      route: route.points,
    });
  }

  const day = daypart();
  const w = wx(day.night);

  const x = Math.random();
  // A little escalation: night nudges retrieval/trauma toward P1.
  const p1 = tpl.p1 + (day.night && tpl.cas ? 0.08 : 0);
  const priority: Priority = x < p1 ? 'P1' : x < p1 + tpl.p2 ? 'P2' : 'P3';

  // A retrieval flies to a tertiary centre; a scene job goes to the nearest
  // receiving hospital. Only the scene case needs a credibility floor: if the
  // hospital is a short drive away then a road ambulance takes it, and there is
  // no air tasking to generate. A retrieval is never dropped — the flight to
  // definitive care IS the job.
  // Most transfers escalate to definitive care, but a meaningful share are
  // regional-to-regional (Lismore -> Tweed Valley and the like).
  // Regional-to-regional transfers are a rotary thing: Lismore to Tweed Valley
  // is 36 NM and routine. A fixed-wing transfer is an escalation to definitive
  // care — flying a major burns patient to a small rural hospital, as this did
  // once burns became a hospital-origin job, is not a transfer anyone makes.
  const regionalTransfer =
    from && tpl.fromHospital && tpl.cls === 'rotary' && chance(0.4)
      ? transferPartner(from, MIN_TRANSPORT_NM[tpl.cls] ?? 0)
      : null;
  const candidateHospital = tpl.transport
    ? (regionalTransfer ?? nearestHospital(lat, lon, tpl.toDefinitiveCare === true))
    : undefined;
  // A fixed-wing aircraft cannot land on a hospital helipad. An RFDS flight
  // goes airport to airport and the patient finishes by road, so the point the
  // aircraft actually flies to is the airport serving that hospital — and that
  // is what the destination marker, the distance and the GPS export must use.
  const arrival = candidateHospital && tpl.cls === 'fixed' ? airportFor(candidateHospital.name) : null;
  const destination: Hospital | undefined = candidateHospital
    ? arrival
      ? { name: `${arrival.name} (${arrival.icao})`, lat: arrival.lat, lon: arrival.lon }
      : candidateHospital
    : undefined;

  const transportNm = destination ? rngNm(lat, lon, destination.lat, destination.lon) : 0;
  const farEnough = tpl.alwaysTransports || transportNm >= (MIN_TRANSPORT_NM[tpl.cls] ?? 0);
  const transportTo: Hospital | undefined =
    destination && farEnough && (tpl.alwaysTransports || chance(0.92)) ? destination : undefined;
  // A fixed-wing transfer has to be a flight. If the referring hospital has no
  // airport, or both hospitals are served by the SAME one, there is nothing to
  // fly — re-roll rather than brief "from Moorabbin to Moorabbin".
  if (strict && tpl.cls === 'fixed' && from && (!departure || (arrival && arrival.icao === departure.icao))) return null;

  // What the briefing calls the destination: the airfield, then the road leg.
  const destinationText = transportTo
    ? arrival && candidateHospital
      ? `${arrival.name} (${arrival.icao}), then by road to ${candidateHospital.name}`
      : transportTo.name
    : undefined;
  const patient = tpl.cas ? makeCasualty(tpl.cas) : undefined;

  // Pick the LZ first: the briefing has to agree with it.
  const lz = rand(tpl.lz);
  // "Recovery to base" / "N/A" means the aircraft never touches down at the
  // scene, so a note about marking the LZ there is nonsense — it put "Landing
  // area is a closed section of road between two appliances" into an aerial
  // survey whose own LZ line said "Recovery to the survey base".
  const landsOnScene = !/^(recovery\b|n\/a\b)/i.test(lz) && tpl.terrain !== 'offshore' && tpl.terrain !== 'airstrip';

  // Compose the briefing: template lead + patient + a complication + access + weather note.
  const compPool = [...(tpl.complications ?? []), ...COMPLICATIONS];
  const parts = [
    tpl.detail({
      loc,
      town: anchor.name,
      region: anchor.region,
      hospital: destinationText,
      night: day.night,
      roads: pursuitRoads,
    }),
    patient ? `Patient: ${patient}` : '',
    chance(0.7) ? rand(compPool) : '',
    landsOnScene && chance(0.7) ? rand(ACCESS_NOTES) : '',
    w.note,
  ].filter(Boolean);

  const eta = priority === 'P1' ? `Priority 1 — go now. Estimate ${rint(35, 75)} min on task.` : priority === 'P2' ? `Priority 2 — respond without delay. ~${rint(60, 110)} min on task.` : `Priority 3 — as tasking allows.`;

  // Police tasking comes down the police net, not the aeromedical one — the
  // generic pools below would have a pursuit "sourced" from the state health
  // operations centre with the referring hospital as the informant.
  const isPolice = tpl.category === 'Police aviation';

  // Who else is at the scene. A ground response only makes sense where there IS
  // a scene with people at it — a road ambulance has no business being listed
  // on an aerial survey of a catchment or an offshore surveillance patrol.
  const support = isPolice
    ? [
        'Dog unit responding',
        'Ground units on the cordon',
        'Road policing intercept crews staged',
        'Tactical response group staging',
        'Local station units attached',
        'Forward command post established',
        'Duty inspector on the radio',
      ]
    : tpl.cas
    ? ['Road ambulance on scene', 'Police en route', 'Fire service on scene', 'Local rescue unit responding', 'SES road crew tasked', 'Duty clinician on the line']
    : landsOnScene
      ? ['Police en route', 'Fire service on scene', 'Local rescue unit responding', 'SES road crew tasked', 'Ground party at the LZ']
      : ['Duty operations manager on the line', 'Sensor/mission specialist aboard', 'Coordination centre monitoring', 'Ground agency liaison on the radio'];

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    status: 'available',
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    phase: null,

    aircraftClass: tpl.cls,
    priority,
    kind: tpl.kind,
    category: tpl.category,
    agency: agencyName,
    callsign,

    lat,
    lon,
    place:
      tpl.terrain === 'offshore'
        ? `${spot.offNm} NM off ${anchor.name}, ${anchor.region}`
        : `${loc}, ${from?.region ?? anchor.region}`,
    region: from?.region ?? anchor.region,
    latLon: dms(lat, lon),

    brief: `${day.label[0]!.toUpperCase()}${day.label.slice(1)}: ${rand(tpl.brief)}`,
    detail: parts.join(' '),
    source: rand(
      isPolice
        ? [`${agencyName} operations`, 'Police operations centre', 'Police radio (VKC)', 'Duty inspector', 'State intelligence command', 'Triple Zero (000)']
        : [`${agencyName} operations`, 'State health operations centre', 'Triple Zero (000)', 'State duty operations manager', 'Aeromedical coordination'],
    ),
    informant: rand(
      isPolice
        ? ['Ground units on scene', 'Duty inspector', 'Police radio (VKC)', 'Surveillance crew', 'Forward commander', 'Local station sergeant']
        : ['On-scene road crew', 'Duty operations manager', 'Incident controller', 'Reporting person (mobile)', 'Referring hospital', 'Ground search coordinator'],
    ),
    hazards: rand(tpl.hazards),
    persons: rand(tpl.persons),
    access: rand(tpl.access),
    lz,
    units: [`${callsign} (tasked)`, ...support.sort(() => Math.random() - 0.5).slice(0, rint(1, 3))],
    weather: w.text,
    transportTo,
    patient,
    timeline: eta,
    channel: 'emergency',
    groundTargets: groundTargets.length ? groundTargets : undefined,
  };
}

// ---- RAAFv (military) tasking -----------------------------------------

/**
 * Bases, squadrons and airframes come from fleet.ts, which prefers the live
 * RAAFv crew centre and falls back to RAAFv's published order of battle.
 *
 * The old version picked a base and a squadron independently, so the board
 * regularly showed No. 75 Squadron scrambling out of Pearce (75SQN is at Tindal),
 * a KC-30A towline flown from Learmonth (a dry base with no aircraft at all) and
 * a No. 10 Squadron that RAAFv does not have. Tasking now starts from a base,
 * asks what is actually parked there, and only then chooses a mission those
 * aircraft can fly.
 */
type RaafBase = FleetBase;

const p = (ll: { lat: number; lon: number }, altFt: number, speedKt: number) => ({
  lat: ll.lat,
  lon: ll.lon,
  altFt,
  speedKt,
});

/** A run toward a defended point from bearing `brg`, with an RTB turn-away leg. */
function inboundRoute(
  base: RaafBase,
  brg: number,
  o: { far: number; alt: number; spd: number; wobble: number; level?: boolean },
): AirTarget['route'] {
  const entry = project(base.lat, base.lon, brg, o.far);
  const mid = project(base.lat, base.lon, brg + (Math.random() - 0.5) * o.wobble, o.far * 0.5);
  const near = project(base.lat, base.lon, brg + (Math.random() - 0.5) * o.wobble, o.far * 0.18);
  const rtbBrg = (brg + 140 + Math.random() * 80) % 360;
  const turn = project(near.lat, near.lon, rtbBrg, 18);
  const away = project(near.lat, near.lon, rtbBrg, o.far * 0.85);
  const low = o.level ? o.alt : Math.max(2000, Math.round(o.alt * 0.6));
  const slow = Math.max(160, Math.round(o.spd * 0.8));
  return [
    p(entry, o.alt, o.spd),
    p(mid, o.alt, o.spd),
    p(near, low, slow),
    p(turn, low, Math.max(150, Math.round(o.spd * 0.7))),
    p(away, o.alt, o.spd),
  ];
}

/** A four-corner racetrack centred on a point (AAR / CAP / adversary orbit). */
function racetrack(c: { lat: number; lon: number }, lenNm: number, widNm: number, alt: number, spd: number): AirTarget['route'] {
  // orientation of the pattern itself — arbitrary, and unrelated to where the
  // task sits, so this one stays a free random bearing.
  const brg = Math.random() * 360;
  const head = project(c.lat, c.lon, brg, lenNm / 2);
  const tail = project(c.lat, c.lon, (brg + 180) % 360, lenNm / 2);
  return [
    p(project(head.lat, head.lon, (brg + 90) % 360, widNm / 2), alt, spd),
    p(project(tail.lat, tail.lon, (brg + 90) % 360, widNm / 2), alt, spd),
    p(project(tail.lat, tail.lon, (brg + 270) % 360, widNm / 2), alt, spd),
    p(project(head.lat, head.lon, (brg + 270) % 360, widNm / 2), alt, spd),
  ];
}

/** A level airway leg between the base area and a distant point (transport / VIP). */
function airwayRoute(base: RaafBase, brg: number, far: number, alt: number, spd: number): AirTarget['route'] {
  const p0 = project(base.lat, base.lon, (brg + 180) % 360, 25 + Math.random() * 20);
  const p1 = project(base.lat, base.lon, brg, far * 0.5);
  const p2 = project(base.lat, base.lon, brg, far);
  return [p(p0, Math.round(alt * 0.75), Math.round(spd * 0.85)), p(p1, alt, spd), p(p2, alt, spd)];
}

/**
 * Which way the area of operations lies from the base.
 *
 * Every build used `Math.random() * 360`, so roughly half of all tasking landed
 * out to sea — an "AO" pinned in the Coral Sea while the brief named a hinterland
 * town. `base.sea` is the bearing toward open water, so the reciprocal is land.
 * A quarter of tasks still go seaward, which is realistic for air defence and
 * maritime work; those get an honest over-water place name (see aoPlaceName).
 *
 * `landOnly` matters for tasking that has to happen on the ground: a drop
 * zone, a JTAC's troops, or an aeromedical evacuation loading litter patients
 * with "ambulances airside". Without it the 25% maritime branch was putting
 * casualty loading points in the Tasman Sea.
 */
function aoBearing(base: RaafBase, landOnly = false): number {
  if (!landOnly && chance(0.25)) return Math.random() * 360; // genuinely maritime tasking
  const inland = base.sea + 180;
  const spread = landOnly ? 90 : 150;
  return (inland + (Math.random() - 0.5) * spread + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * Describe where a task datum actually is. Naming the nearest town is only
 * honest when there IS a town near it; 130 NM offshore the nearest anchor is
 * still "Gold Coast hinterland", which is how an ocean pin ended up captioned
 * as a hinterland job. Beyond 70 NM from any anchor, say it as a bearing and
 * range from the base instead.
 */
function aoPlaceName(base: RaafBase, lat: number, lon: number): { label: string; phrase: string } {
  let best = ANCHORS[0]!;
  let d = Infinity;
  for (const a of ANCHORS) {
    const dd = rngNm(lat, lon, a.lat, a.lon);
    if (dd < d) {
      d = dd;
      best = a;
    }
  }
  // 120 NM rather than 70: most Australian tasking is within that of somewhere
  // with a name, and a named town reads far better than a bearing.
  if (d <= 120) return { label: best.name, phrase: best.name };
  const brg = (Math.atan2(lon - base.lon, lat - base.lat) * 180) / Math.PI;
  const pt = COMPASS[Math.round(((brg + 360) % 360) / 22.5) % 16];
  const nm = Math.round(rngNm(base.lat, base.lon, lat, lon));
  // The label goes in the place column, where the base is already named beside
  // it; the phrase goes into sentences, where it has to stand on its own.
  return { label: `${nm} NM ${pt}`, phrase: `a point ${nm} NM ${pt} of ${base.name}` };
}

const DEFENDED: { name: string; lat: number; lon: number }[] = [
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Newcastle', lat: -32.93, lon: 151.78 },
  { name: 'Canberra', lat: -35.31, lon: 149.2 },
  { name: 'Brisbane', lat: -27.47, lon: 153.03 },
  { name: 'the Gold Coast', lat: -28.0, lon: 153.43 },
  { name: 'Melbourne', lat: -37.81, lon: 144.96 },
  { name: 'Adelaide', lat: -34.93, lon: 138.6 },
  { name: 'Perth', lat: -31.95, lon: 115.86 },
  { name: 'Darwin', lat: -12.46, lon: 130.84 },
  { name: 'Townsville', lat: -19.26, lon: 146.82 },
];
/**
 * The state the job is actually in. The region used to be copied from the home
 * base, so a sustainment run from Fairbairn to Curtin was filed under "ACT"
 * with a pin in the Kimberley — and the console's sector column, which is what
 * an operator sorts the board on, said the same wrong thing.
 */
function regionAt(lat: number, lon: number, fallback: string): string {
  let best: Anchor | null = null;
  let d = Infinity;
  for (const a of ANCHORS) {
    const dd = rngNm(lat, lon, a.lat, a.lon);
    if (dd < d) {
      d = dd;
      best = a;
    }
  }
  return best && d <= 400 ? best.region : fallback;
}

/**
 * What the base is defending. Measured from the BASE, not from the threat: the
 * thing being protected is behind you, and a fighter launches to keep a track
 * away from it.
 *
 * `notThis` stops the one sentence that gave the game away — an intercept
 * brief reading "inbound from the direction of Newcastle toward Newcastle",
 * which happens whenever the track's datum and the defended city share the
 * nearest anchor.
 */
function nearestDefended(lat: number, lon: number, notThis?: string): string {
  let best: { name: string; lat: number; lon: number } | null = null;
  let d = Infinity;
  for (const x of DEFENDED) {
    if (notThis && x.name === notThis) continue;
    const dd = rngNm(lat, lon, x.lat, x.lon);
    if (dd < d) {
      d = dd;
      best = x;
    }
  }
  return (best ?? DEFENDED[0]!).name;
}

/**
 * Real Australian Defence training areas and air weapons ranges.
 *
 * Ground-attack tasking used to be dropped on a random bearing from the base and
 * captioned with whatever town was nearest, so a "CAS keyhole" could sit over a
 * suburb and a live drop could be briefed onto farmland. Australian air-to-ground
 * work happens in a short, well-known list of places — these — and putting the
 * job inside one is both safer reading and immediately recognisable to anyone who
 * flies the area.
 */
type Range = { name: string; lat: number; lon: number; kind: 'awr' | 'field' };
const RANGES: Range[] = [
  { name: 'Salt Ash Air Weapons Range', lat: -32.75, lon: 151.95, kind: 'awr' },
  { name: 'Beecroft Weapons Range', lat: -35.05, lon: 150.8, kind: 'awr' },
  { name: 'Evans Head Air Weapons Range', lat: -29.12, lon: 153.42, kind: 'awr' },
  { name: 'Singleton Military Area', lat: -32.6, lon: 151.2, kind: 'field' },
  { name: 'Shoalwater Bay Training Area', lat: -22.4, lon: 150.3, kind: 'field' },
  { name: 'Townsville Field Training Area', lat: -19.55, lon: 146.6, kind: 'field' },
  { name: 'Wide Bay Training Area', lat: -25.85, lon: 152.4, kind: 'field' },
  { name: 'Delamere Air Weapons Range', lat: -15.77, lon: 131.72, kind: 'awr' },
  { name: 'Bradshaw Field Training Area', lat: -15.3, lon: 130.7, kind: 'field' },
  { name: 'Mount Bundey Training Area', lat: -12.9, lon: 131.65, kind: 'field' },
  { name: 'Cultana Training Area', lat: -32.8, lon: 137.35, kind: 'field' },
  { name: 'the Woomera Range Complex', lat: -30.95, lon: 136.5, kind: 'awr' },
  { name: 'Puckapunyal Military Area', lat: -36.95, lon: 145.05, kind: 'field' },
  { name: 'Lancelin Training Area', lat: -31.05, lon: 115.35, kind: 'awr' },
  { name: 'Yampi Sound Training Area', lat: -16.3, lon: 123.9, kind: 'field' },
];

/** The nearest range to a base, preferring a live-fire one where asked. */
function rangeFor(base: RaafBase, kind?: Range['kind']): Range {
  const pool = kind ? RANGES.filter((r) => r.kind === kind) : RANGES;
  let best = pool[0]!;
  let d = Infinity;
  for (const r of pool) {
    const dd = rngNm(base.lat, base.lon, r.lat, r.lon);
    if (dd < d) {
      d = dd;
      best = r;
    }
  }
  return best;
}

/** A point inside a range's working area, not its exact centre. */
function inRange(r: Range, spreadNm = 8): { lat: number; lon: number } {
  return project(r.lat, r.lon, Math.random() * 360, Math.random() * spreadNm);
}

/**
 * Every aerodrome we know of, flattened once — used for AME and airlift ends.
 *
 * `major` matters: the pre-baked list is everything OSM calls an aerodrome, so
 * without it a C-130J aeromedical evacuation was being sent to a private grass
 * strip with "ambulances airside". Names ending in "Airport" are the ones with
 * a sealed runway and somewhere to park.
 */
let ALL_AERODROMES: Aerodrome[] | null = null;
function aerodromeNear(lat: number, lon: number, maxNm = 140, major = false, notIcao?: string): Aerodrome | null {
  if (!ALL_AERODROMES) {
    const seen = new Set<string>();
    ALL_AERODROMES = [];
    for (const list of Object.values(AERODROMES)) {
      for (const a of list) {
        if (seen.has(a.icao)) continue;
        seen.add(a.icao);
        ALL_AERODROMES.push(a);
      }
    }
  }
  let best: Aerodrome | null = null;
  let d = maxNm;
  let pool = major ? ALL_AERODROMES.filter((a) => /airport$/i.test(a.name)) : ALL_AERODROMES;
  if (notIcao) pool = pool.filter((a) => a.icao !== notIcao);
  for (const a of pool) {
    const dd = rngNm(lat, lon, a.lat, a.lon);
    if (dd < d) {
      d = dd;
      best = a;
    }
  }
  // A sealed field is a preference, not a requirement — outback tasking would
  // otherwise have nowhere to go at all.
  return best ?? (major ? aerodromeNear(lat, lon, maxNm, false, notIcao) : null);
}

/**
 * A task that happens AT an airfield — an AME pickup, a sustainment run, a VIP
 * arrival, the destination of an instrument detail. These used to be pinned at a
 * random point in the bush while the brief said "ambulances airside", so they
 * snap to a real aerodrome and the brief quotes the same one.
 */
function fieldTask(
  base: RaafBase,
  minNm: number,
  maxNm: number,
  major = true,
): { lat: number; lon: number; dest: string } {
  const brg = aoBearing(base, true);
  const at = project(base.lat, base.lon, brg, minNm + Math.random() * (maxNm - minNm));
  const field =
    aerodromeNear(at.lat, at.lon, 160, major, base.ident) ?? aerodromeNear(at.lat, at.lon, 400, major, base.ident);
  if (!field) return { lat: at.lat, lon: at.lon, dest: aoPlaceName(base, at.lat, at.lon).phrase };
  return { lat: field.lat, lon: field.lon, dest: `${field.name} (${field.icao})` };
}

/**
 * A forward-base run goes to one of RAAFv's dry bases — the ones with no
 * resident squadron that air mobility stands up as a detachment. That is what
 * those bases are FOR, and it is far better tasking than "the nearest strip".
 */
function dryBaseFrom(base: RaafBase): RaafBase | null {
  // Far enough to be a real deployment, near enough to be a day's tasking: a
  // sustainment shuttle from Canberra to Curtin is 1700 NM and is not a shuttle.
  const pool = RAAFV_BASES.filter((b) => {
    if (!b.dry) return false;
    const d = rngNm(base.lat, base.lon, b.lat, b.lon);
    return d > 150 && d < 1500;
  }).sort((a, b) => rngNm(base.lat, base.lon, a.lat, a.lon) - rngNm(base.lat, base.lon, b.lat, b.lon));
  return pool.length ? rand(pool.slice(0, 4)) : null;
}

/**
 * The refuelling track a base would actually use — the one whose rendezvous
 * control point is nearest.
 *
 * Australia refuels on eight published tracks, so "somewhere on a random
 * bearing 60-150 NM out" was never right. The tanker now flies a real one and
 * the brief can name it.
 */
function trackFor(base: RaafBase): RefuellingTrack {
  let best = REFUELLING_TRACKS[0]!;
  let d = Infinity;
  for (const t of REFUELLING_TRACKS) {
    const rvcp = t.points.find((p2) => p2.id === t.rvcp) ?? t.points[0]!;
    const dd = rngNm(base.lat, base.lon, rvcp.lat, rvcp.lon);
    if (dd < d) {
      d = dd;
      best = t;
    }
  }
  return best;
}

/** A named waypoint on a track. */
function wpt(track: RefuellingTrack, id: string): Waypoint {
  return track.points.find((p2) => p2.id === id) ?? track.points[0]!;
}

/**
 * The AAR/AEW&C anchor airspace serving a base. Keyed by the base's own name
 * where the handbook publishes one; otherwise the nearest published set, since
 * a squadron without its own anchor airspace still has to orbit somewhere.
 */
function anchorsFor(base: RaafBase): Waypoint[] {
  const own = AAR_ANCHORS[base.name.replace(/^(RAAFv Base |vDefence Establishment )/, '')];
  if (own?.length) return own;
  let best: Waypoint[] = [];
  let d = Infinity;
  for (const pts of Object.values(AAR_ANCHORS)) {
    if (!pts.length) continue;
    const dd = rngNm(base.lat, base.lon, pts[0]!.lat, pts[0]!.lon);
    if (dd < d) {
      d = dd;
      best = pts;
    }
  }
  return best;
}

// -- threat profiles for intercept tasking ---------------------------
type Threat = {
  label: (fl: number) => string;
  titleHint: AirTarget['titleHint'];
  alt: [number, number];
  spd: [number, number];
  far: [number, number];
  shape: 'straight' | 'meander' | 'airway';
  formation?: [number, number];
  squawk: string;
  hold: number;
};
const THREATS: Record<string, Threat> = {
  fast: { label: (fl) => `Fast mover, FL${fl}`, titleHint: 'jet', alt: [28000, 41000], spd: [420, 520], far: [150, 220], shape: 'straight', squawk: '0000', hold: 95 },
  raid: { label: (fl) => `Raid - fast movers, FL${fl}`, titleHint: 'jet', alt: [26000, 38000], spd: [440, 540], far: [170, 250], shape: 'straight', formation: [2, 3], squawk: '0000', hold: 110 },
  airliner: { label: (fl) => `Airliner, FL${fl}, NORDO`, titleHint: 'heavy', alt: [31000, 39000], spd: [420, 470], far: [150, 220], shape: 'airway', squawk: '7600', hold: 90 },
  light: { label: () => `Light aircraft, low level, NORDO`, titleHint: 'light', alt: [2500, 7500], spd: [95, 150], far: [70, 120], shape: 'meander', squawk: '7600', hold: 45 },
  uas: { label: () => `Slow, small radar return - ? UAS`, titleHint: 'light', alt: [3000, 9000], spd: [60, 110], far: [50, 90], shape: 'meander', squawk: '0000', hold: 35 },
  heli: { label: () => `Helicopter, low and slow, NORDO`, titleHint: 'light', alt: [500, 2500], spd: [70, 120], far: [40, 80], shape: 'meander', squawk: '7600', hold: 35 },
};

function intercept(base: RaafBase, t: Threat): { lat: number; lon: number; targets: AirTarget[] } {
  const brg = aoBearing(base);
  const far = rint(t.far[0], t.far[1]);
  const alt = rint(Math.round(t.alt[0] / 1000), Math.round(t.alt[1] / 1000)) * 1000;
  const spd = Math.round(rint(t.spd[0], t.spd[1]) / 10) * 10;
  const fl = Math.round(alt / 100);
  const n = t.formation ? rint(t.formation[0], t.formation[1]) : 1;
  const wobble = t.shape === 'meander' ? 60 : t.shape === 'airway' ? 4 : 15;
  const route = inboundRoute(base, brg, { far, alt, spd, wobble, level: t.shape === 'airway' });
  const datum = project(base.lat, base.lon, brg, far * 0.4);
  const label = t.label(fl);
  return {
    lat: datum.lat,
    lon: datum.lon,
    targets: [
      {
        label: n > 1 ? `${label} x${n}` : label,
        titleHint: t.titleHint,
        formation: n > 1 ? n : undefined,
        holdUntilNm: t.hold,
        squawk: t.squawk,
        route,
      },
    ],
  };
}

type RaafCtx = {
  base: string;
  ident: string;
  place: string;
  defended: string;
  controller: string;
  roe: string;
  night: boolean;
  /** what is being flown, e.g. "F-35A Lightning II" */
  type: string;
  /** the squadron flying it */
  squadron: string;
  /** the nearest training area / weapons range, named */
  range: string;
  /** a real destination aerodrome, for tasking that goes somewhere */
  dest: string;
  /** the base's local training airspace, in words */
  area: string;
  /** published refuelling track and its points, for AAR tasking */
  track: string;
  rvip: string;
  rvcp: string;
  navChk: string;
  exitPt: string;
  block: string;
  freq: string;
  /** published anchor waypoint, for AEW&C tasking */
  anchor: string;
};

type RaafTpl = {
  kind: string;
  category: string;
  /**
   * The capabilities that can fly this task — see fleet.ts Role. Any one of
   * them is enough. It is a list because several tasks are genuinely flown by
   * more than one type: the sea-air gap patrol suits both the Poseidon and the
   * Wedgetail, and forcing a single role made the E-7A fly surface searches.
   */
  roles: Role[];
  weight?: number;
  p1: number;
  p2: number;
  offshore?: boolean;
  brief: string[];
  detail: (c: RaafCtx) => string;
  hazards: string[];
  access: string[];
  lz: string[];
  /** persons on task — "N/A" for most, a patient load for AME */
  persons?: (c: RaafCtx) => string;
  /** how urgent it reads on the board; ALERT 5 belongs to QRA and nothing else */
  timeline: (pri: Priority) => string;
  /**
   * `range` and `dest` are returned by build, not recomputed for the brief:
   * working them out twice is how a FAC talk-on ended up pinned over one
   * weapons range and briefed onto another.
   */
  build: (base: RaafBase) => {
    lat: number;
    lon: number;
    targets?: AirTarget[];
    range?: string;
    dest?: string;
    /** a published refuelling track, when the task is flown on one */
    track?: RefuellingTrack;
    /** a published anchor waypoint, when the task orbits one */
    anchor?: string;
  };
};

const RAAFV_TEMPLATES: RaafTpl[] = [
  {
    kind: 'QRA Scramble - Intercept',
    category: 'Air defence',
    roles: ['qra'],
    weight: 4,
    p1: 0.9,
    p2: 0.1,
    brief: [
      'ALERT 5 - unidentified track inbound, no flight plan, no comms.',
      'Scramble - track of interest not responding to ATC.',
      'Fighters go - fast, no squawk, closing controlled airspace.',
    ],
    detail: (c) =>
      `Scramble a pair of ${c.squadron} ${c.type} from ${c.base}. An unidentified track is inbound from the direction of ${c.place} toward ${c.defended}. ${c.controller} has control. Run the intercept, get a visual ID, then ${c.roe} If it will not comply, be prepared to shoulder it away from ${c.defended}.`,
    hazards: ['High closure, wake turbulence, airliner density', 'Controlled airspace, night VID, other fighters on frequency'],
    access: ['N/A - airborne intercept'],
    lz: ['Recovery to base or a nominated divert'],
    timeline: (pri) => (pri === 'P1' ? 'ALERT 5 - airborne inside five minutes.' : 'ALERT 15 - cockpit ready, launch on the call.'),
    build: (base) => intercept(base, chance(0.3) ? THREATS.raid! : THREATS.fast!),
  },
  {
    kind: 'QRA Scramble - Slow Mover',
    category: 'Air defence',
    roles: ['qra'],
    weight: 2,
    p1: 0.55,
    p2: 0.4,
    brief: [
      'Light aircraft NORDO, drifting toward a restricted area.',
      'Slow, low, small return - possible UAS near a sensitive site.',
      'Helicopter NORDO, low level, tracking toward a prohibited zone.',
    ],
    detail: (c) =>
      `Launch from ${c.base}. A slow, low-level track near ${c.place} is not responding and is tracking toward restricted airspace near ${c.defended}. ${c.controller} has control. Carry out a covert then overt intercept, pass visual signals, and ${c.roe}`,
    hazards: ['Low speed and low level over terrain', 'Poor target conspicuity, wires, birds'],
    access: ['N/A - airborne intercept'],
    lz: ['Recovery to base'],
    timeline: (pri) => (pri === 'P1' ? 'ALERT 5 - airborne inside five minutes.' : 'ALERT 15 - brief and launch.'),
    build: (base) => intercept(base, rand([THREATS.light!, THREATS.uas!, THREATS.heli!])),
  },
  {
    kind: 'Comms-Loss Airliner Shadow',
    category: 'Air defence',
    roles: ['qra'],
    weight: 2,
    p1: 0.7,
    p2: 0.3,
    brief: ['Airliner squawking 7600, no voice contact, on an airway.', 'Heavy jet NORDO - verify flight deck state.'],
    detail: (c) =>
      `An airliner on the airway near ${c.place} is squawking 7600 with no voice contact. ${c.controller} requests a discreet shadow. Close from behind and below, look through the flight deck windows for signs of life or a hijack indicator, relay what you see, and stay with it toward ${c.defended}. ${c.roe}`,
    hazards: ['Wake behind a heavy, passenger optics - stay discreet', 'Sun or night on the flight deck, TCAS RAs'],
    access: ['N/A - airborne shadow'],
    lz: ['Recovery once relieved'],
    timeline: () => 'ALERT 5 - the track is already airborne and running.',
    build: (base) => intercept(base, THREATS.airliner!),
  },
  {
    kind: 'Combat Air Patrol - CAP Station',
    category: 'Air defence',
    roles: ['cap'],
    weight: 2,
    p1: 0.15,
    p2: 0.5,
    brief: ['Hold the CAP station, be ready to commit.', 'Establish a defensive CAP over the exercise area.'],
    detail: (c) =>
      `Establish a CAP for ${c.defended} on the assigned station near ${c.place}. Fly the racetrack at the briefed height and airspeed, hold an accurate hack, manage fuel to your bingo, and be ready to commit on ${c.controller}. Relieved on station.`,
    hazards: ['Long time on station, fuel management, formation in the block', 'Weather and other CAP fighters'],
    access: ['N/A - CAP station'],
    lz: ['Recovery to base or the tanker'],
    timeline: () => 'On station at the briefed vul time - plan the transit back from it.',
    build: (base) => {
      const brg = aoBearing(base);
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 120);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Escort - Transport Corridor',
    category: 'Air defence',
    roles: ['cap'],
    p1: 0.1,
    p2: 0.4,
    brief: ['Escort a transport along the corridor to the forward base.', 'Shadow a VIP aircraft through the sector.'],
    detail: (c) =>
      `Depart ${c.base} and rendezvous with a transport routing toward ${c.place}. Escort it along the corridor, keep a visual watch either side, and hand it to the terminal controller at ${c.dest}. ${c.controller} has coordination.`,
    hazards: ['Speed mismatch, formation, terrain and weather in the corridor', 'Night formation join'],
    access: ['N/A - airborne'],
    lz: ['Recovery to base'],
    timeline: () => 'Rendezvous time is fixed by the transport - be at the join point early.',
    build: (base) => {
      const brg = aoBearing(base, true);
      const far = 160 + Math.random() * 140;
      const heavy = chance(0.4);
      const datum = project(base.lat, base.lon, brg, far * 0.45);
      return {
        lat: datum.lat,
        lon: datum.lon,
        targets: [
          {
            label: heavy ? 'BBJ (VIP), FL390' : 'Transport, FL240',
            titleHint: 'heavy',
            holdUntilNm: 80,
            route: airwayRoute(base, brg, far, heavy ? 39000 : 24000, heavy ? 440 : 300),
          },
        ],
      };
    },
  },
  {
    kind: 'Air Combat Training (DACT)',
    category: 'Air combat training',
    roles: ['dact'],
    weight: 2,
    p1: 0.1,
    p2: 0.45,
    brief: ['1v1 to the merge in the training area.', 'Basic fighter manoeuvres with an adversary.'],
    detail: (c) =>
      `Proceed to ${c.area} for dissimilar air combat training in the ${c.type}. An adversary is holding on a racetrack - fight to the merge, keep it inside the area, mind the floor and the deconfliction plan, and knock it off at your bingo.`,
    hazards: ['High-G, spatial disorientation, mid-air risk', 'Area floor and ceiling, cloud in the block'],
    access: ['N/A - training area'],
    lz: ['Recovery to base'],
    timeline: () => 'Booked airspace slot - airborne on time or the area is lost.',
    build: (base) => {
      const brg = aoBearing(base);
      const c = project(base.lat, base.lon, brg, 50 + Math.random() * 90);
      const alt = 24000 + Math.round(Math.random() * 10) * 1000;
      return {
        lat: c.lat,
        lon: c.lon,
        targets: [{ label: `Adversary, FL${Math.round(alt / 100)}`, titleHint: 'jet', loop: true, holdUntilNm: 60, route: racetrack(c, 24, 8, alt, 360) }],
      };
    },
  },
  {
    kind: 'Lead-In Fighter - Air Combat Intro',
    category: 'Air combat training',
    roles: ['lif'],
    weight: 2,
    p1: 0,
    p2: 0.35,
    brief: ['Introductory fighter course - 1v1 in the training area.', 'Lead-in fighter sortie: handling, then a fight.'],
    detail: (c) =>
      `Introductory Fighter Course sortie in the ${c.type}. Depart ${c.base} for ${c.area}, work through the handling sequence, then fight the staff aircraft to the merge. Height block and floor as briefed, knock it off at bingo, and debrief the tape on the ground. ${c.controller} for the area.`,
    hazards: ['Student under high workload, G-induced fatigue', 'Area floor, cloud in the block, other training traffic'],
    access: ['N/A - training area'],
    lz: ['Recovery to base'],
    timeline: () => 'Booked airspace slot - the staff aircraft is on the wave behind you.',
    build: (base) => {
      const brg = aoBearing(base);
      const c = project(base.lat, base.lon, brg, 35 + Math.random() * 60);
      const alt = 18000 + Math.round(Math.random() * 6) * 1000;
      return {
        lat: c.lat,
        lon: c.lon,
        targets: [{ label: `Staff aircraft, FL${Math.round(alt / 100)}`, titleHint: 'jet', loop: true, holdUntilNm: 45, route: racetrack(c, 18, 6, alt, 300) }],
      };
    },
  },
  {
    kind: 'Air-To-Air Refuelling - Towline',
    category: 'Air mobility',
    roles: ['aar'],
    weight: 2,
    p1: 0.05,
    p2: 0.45,
    brief: ['Establish the towline, receivers inbound.', 'Pre-planned AAR bracket - fighters need fuel.'],
    detail: (c) =>
      `Take the ${c.type} from ${c.base} to ${c.track}. Join at ${c.rvip}, set up on the track at ${c.rvcp} in the ${c.block} block, and run it via ${c.navChk} to ${c.exitPt}. Hold height and speed steady while the receivers cycle through and pass the planned offload. Refuelling frequency ${c.freq}, ${c.controller} has the block. Fighters join from below and behind - do not manoeuvre once they are in contact.`,
    hazards: ['Receivers in close formation, wake, cloud in the block', 'Long time in the block, fuel planning for the offload'],
    access: ['N/A - published refuelling track'],
    lz: ['Recovery to base'],
    timeline: () => 'On the towline by the briefed bracket time - the receivers plan their fuel around it.',
    build: (base) => {
      const track = trackFor(base);
      const rvcp = wpt(track, track.rvcp);
      // Fly the published track rather than a racetrack on a random bearing.
      const alt = chance(0.5) ? 25000 : 30000;
      const legs = track.points.map((w) => p(w, alt, 290));
      return {
        lat: rvcp.lat,
        lon: rvcp.lon,
        track,
        targets: [
          {
            label: `Receivers - fighter pair, FL${Math.round(alt / 100)}`,
            titleHint: 'jet',
            formation: 2,
            holdUntilNm: 70,
            route: legs,
            loop: true,
          },
        ],
      };
    },
  },
  {
    kind: 'Airborne Insertion - Paratroop Drop',
    category: 'Air mobility',
    roles: ['airdrop'],
    weight: 2,
    p1: 0.1,
    p2: 0.4,
    brief: ['Low-level run-in to the DZ, static-line drop.', 'Deliver paratroops onto the drop zone.'],
    detail: (c) =>
      `Fly the ${c.type} from ${c.base} to the drop zone at ${c.range}. Run in at low level and drop speed on the briefed heading, hit the release point on time, then climb away and re-join the airway. The DZ party is on the ground and will call the wind. ${c.controller} for airspace.`,
    hazards: ['Low level at low speed, heavy aircraft - no margin for a late correction', 'Canopies in the air behind you, wires and stock near the DZ'],
    access: ['Drop zone - no landing'],
    lz: ['Recovery to base'],
    persons: () => `${rint(24, 90)} paratroops and the dispatch crew`,
    timeline: () => 'Time on target is fixed - the DZ party and the ground scheme are built around it.',
    build: (base) => {
      const r = rangeFor(base, 'field');
      const dz = inRange(r, 5);
      const range = r.name;
      const run = Math.random() * 360;
      const run0 = project(dz.lat, dz.lon, (run + 180) % 360, 18);
      const run2 = project(dz.lat, dz.lon, run, 12);
      return {
        lat: dz.lat,
        lon: dz.lon,
        range,
        targets: [
          {
            label: 'Formation lead - 1200 ft, 130 kt',
            titleHint: 'heavy',
            holdUntilNm: 40,
            route: [p(run0, 6000, 210), p(dz, 1200, 130), p(run2, 1200, 130), p(project(run2.lat, run2.lon, run, 60), 9000, 240)],
          },
        ],
      };
    },
  },
  {
    kind: 'Close Air Support - JTAC',
    category: 'Strike / ISR',
    roles: ['cas'],
    weight: 2,
    p1: 0.2,
    p2: 0.5,
    brief: ['Check in with the JTAC, hold the wheel, be ready for a 9-line.', 'CAS on-call over the ground scheme of manoeuvre.'],
    detail: (c) =>
      `Transit to the CAS keyhole over ${c.range} and check in with the JTAC. Set up a wheel at the briefed height, build a picture of the friendly and target locations, read back the 9-line, and remain on-station to your bingo. ${c.controller} for airspace.`,
    hazards: ['Terrain masking, simulated threat envelope, other CAS aircraft in the stack', 'Density altitude, dust and smoke on the target'],
    access: ['N/A - CAS keyhole'],
    lz: ['Recovery to base or the tanker'],
    timeline: () => 'On-call - be overhead for the ground force H-hour.',
    build: (base) => {
      const r = rangeFor(base);
      const c = inRange(r, 10);
      return { lat: c.lat, lon: c.lon, range: r.name };
    },
  },
  {
    kind: 'Forward Air Control - Talk-On',
    category: 'Strike / ISR',
    roles: ['fac'],
    p1: 0.15,
    p2: 0.45,
    brief: ['FAC(A) over the range - mark and talk fast jets onto the target.', 'Control the stack for a CAS serial.'],
    detail: (c) =>
      `Take the ${c.type} to ${c.range} as the airborne forward air controller. Hold a wheel above the target area, build the picture, mark the target, then talk each pair of fast jets onto it and clear them hot. Keep the stack deconflicted by height and watch your own fuel. ${c.controller} for the area.`,
    hazards: ['Slow aircraft low over a live range, small-arms envelope', 'Multiple aircraft in the stack, talk-on workload'],
    access: ['N/A - overhead the range'],
    lz: ['Recovery to base'],
    timeline: () => 'Be on station before the first CAS pair checks in.',
    build: (base) => {
      const r = rangeFor(base);
      const c = inRange(r, 8);
      return { lat: c.lat, lon: c.lon, range: r.name };
    },
  },
  {
    kind: 'Tactical Reconnaissance Run',
    category: 'Strike / ISR',
    roles: ['recon'],
    p1: 0.1,
    p2: 0.4,
    brief: ['Single fast pass over the target for imagery.', 'Low-level recon of the coastal strip.'],
    detail: (c) =>
      `Fly a tactical reconnaissance run over the objective at ${c.range}. Ingress low and fast on the briefed heading, hold the line and speed through the target for the sensor, one pass only, then egress and climb. ${c.controller} for deconfliction.`,
    hazards: ['Very low level at high speed, wires and towers, bird strike', 'One-pass discipline - no re-attacks'],
    access: ['N/A - recon track'],
    lz: ['Recovery to base'],
    timeline: () => 'Time on target to the minute - the imagery is worthless late.',
    build: (base) => {
      const r = rangeFor(base);
      const c = inRange(r, 12);
      return { lat: c.lat, lon: c.lon, range: r.name };
    },
  },
  {
    kind: 'Maritime Patrol - Surface Picture',
    category: 'ISR / maritime',
    roles: ['maritime'],
    weight: 2,
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    brief: ['Build the surface picture in the patrol box.', 'Investigate an AIS-dark contact offshore.'],
    detail: (c) =>
      `Transit the ${c.type} from ${c.base} to the maritime patrol box offshore from ${c.place}. Run the search pattern, log every contact with position, course and speed, photograph anything of interest, and stay above 500 ft over vessels unless directed otherwise. ${c.controller} for the area.`,
    hazards: ['Low level over water, crew fatigue, birds', 'Weather building offshore, rig traffic and helicopter lanes'],
    access: ['N/A - patrol box'],
    lz: ['Recovery to base'],
    timeline: () => 'Long tasking - plan the fuel and the crew duty before you sign for it.',
    build: (base) => {
      const brg = base.sea + (Math.random() - 0.5) * 40;
      const c = project(base.lat, base.lon, brg, 120 + Math.random() * 180);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Sovereignty Patrol - Northern Approaches',
    category: 'ISR / maritime',
    roles: ['maritime', 'aewc'],
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    brief: ['Patrol the northern approaches, report all air and surface tracks.', 'Presence patrol along the sea-air gap.'],
    detail: (c) =>
      `Patrol the northern approaches out of ${c.base}. Sweep the assigned lane toward the sea-air gap, correlate every air and surface track, investigate anything unusual, and report to ${c.controller}. Long tasking - manage crew and fuel, and note the nearest divert is a long way behind you.`,
    hazards: ['Very long endurance, remote diversion options', 'Tropical weather, other patrol assets in the lane'],
    access: ['N/A - patrol lane'],
    lz: ['Recovery to base'],
    timeline: () => 'Long tasking - brief the divert plan before you launch.',
    build: (base) => {
      const brg = base.sea + (Math.random() - 0.5) * 30;
      const c = project(base.lat, base.lon, brg, 180 + Math.random() * 220);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Search and Rescue - Search Pattern',
    category: 'ISR / maritime',
    roles: ['sar'],
    weight: 2,
    p1: 0.75,
    p2: 0.25,
    offshore: true,
    brief: ['Overdue vessel - fly the search pattern and find it.', 'EPIRB detection offshore, no voice contact.', 'Missing aircraft - search the last known track.'],
    detail: (c) =>
      `JRCC has requested the ${c.type} for a search offshore from ${c.place}. Fly the assigned creeping-line pattern at search height and speed, put every crew position on a sector, and report any sighting immediately with a position. Be prepared to drop stores and hold overhead until surface units arrive. ${c.controller} for the area.`,
    hazards: ['Low level over water, sea state and glare, long time on task', 'Other search aircraft in the pattern - height deconfliction is everything'],
    access: ['N/A - search area'],
    lz: ['Recovery to base or the nearest suitable field'],
    persons: () => 'Persons in the water - number unknown',
    timeline: () => 'Immediate - survivability is measured in hours.',
    build: (base) => {
      const brg = base.sea + (Math.random() - 0.5) * 60;
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 160);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'ISR Orbit - Recognised Air Picture',
    category: 'ISR / maritime',
    roles: ['aewc'],
    p1: 0.05,
    p2: 0.35,
    brief: ['Establish an AEW&C orbit over the AO.', 'Provide the recognised air picture for the exercise.'],
    detail: (c) =>
      `Depart ${c.base} in the ${c.type} and set up an AEW&C orbit anchored on ${c.anchor}, near ${c.place}. Build and pass the recognised air picture, control the fighters and the tanker, and remain on station until relieved. ${c.controller} takes hand-over.`,
    hazards: ['Long endurance, other high-level traffic', 'Weather and turbulence at height'],
    access: ['N/A - orbit'],
    lz: ['Recovery to base'],
    timeline: () => 'On station for the start of the vul - everyone else plans around your picture.',
    build: (base) => {
      // The E-7A works the same published airspace as the tankers.
      const pts = anchorsFor(base);
      const a = pts.length ? rand(pts) : null;
      if (!a) {
        const c = project(base.lat, base.lon, aoBearing(base), 60 + Math.random() * 140);
        return { lat: c.lat, lon: c.lon };
      }
      return { lat: a.lat, lon: a.lon, anchor: a.id };
    },
  },
  {
    kind: 'Tactical Airlift - Forward Base',
    category: 'Air mobility',
    roles: ['tactical'],
    weight: 2,
    p1: 0.1,
    p2: 0.45,
    brief: ['Move freight and passengers forward to the detachment.', 'Sustainment run into a bare base.'],
    detail: (c) =>
      `Load the ${c.type} at ${c.base} and run the sustainment shuttle to ${c.dest}. Freight, ground crew and rations forward; unserviceable stores and outbound passengers back. Expect a short turn on the ground with engines running, no air-conditioning cart and no steps. ${c.controller} for routing.`,
    hazards: ['Short turn on the ground, loading in heat, hot refuel', 'Unsurfaced or unlit strip, wildlife on the runway'],
    access: ['Sealed or prepared strip - check the pavement concession before landing'],
    lz: ['Runway at the destination'],
    persons: () => `${rint(6, 40)} passengers and ${rint(2, 8)} pallets`,
    timeline: () => 'The detachment is waiting on this load - same-day turn.',
    build: (base) => {
      const dry = dryBaseFrom(base);
      if (dry) return { lat: dry.lat, lon: dry.lon, dest: `${dry.name} (${dry.ident})` };
      return fieldTask(base, 120, 380);
    },
  },
  {
    kind: 'Air Mobility Shuttle',
    category: 'Air mobility',
    roles: ['transport'],
    weight: 2,
    p1: 0,
    p2: 0.3,
    brief: ['Scheduled passenger and freight run between bases.', 'Move the course and their gear to the detachment.'],
    detail: (c) =>
      `Scheduled air mobility run in the ${c.type} from ${c.base} to ${c.dest}. Passengers, baggage and palletised freight, manifest closed one hour before departure. Standard airways routing, civil terminal procedures at the far end, and a turn-round for the return leg the same day. ${c.controller} for the clearance.`,
    hazards: ['Mixing with civil traffic at the destination', 'Weight and balance with a late manifest change, weather at the far end'],
    access: ['Sealed runway, civil or military apron'],
    lz: ['Sealed runway'],
    persons: () => `${rint(4, 30)} passengers`,
    timeline: () => 'Scheduled departure - the manifest is built around it.',
    build: (base) => fieldTask(base, 150, 450),
  },
  {
    kind: 'Aeromedical Evacuation',
    category: 'Air mobility',
    roles: ['ame'],
    weight: 2,
    p1: 0.4,
    p2: 0.45,
    brief: ['Strategic AME move of casualties to a major hospital.', 'Repatriate patients from a forward location.'],
    detail: (c) =>
      `Position the ${c.type} to ${c.dest}, load the AME team and the litter patients, and transit to the receiving hospital. Smooth handling throughout, cabin altitude restriction for the head-injury patient, ambulances both ends. ${c.controller} for routing and for the priority handling into the destination.`,
    hazards: ['Cabin altitude limits, patient deterioration in flight', 'Long tasking, night arrival, ambulance coordination airside'],
    access: ['Airfield - ambulances airside, patients loaded from the ramp'],
    lz: ['Sealed runway'],
    persons: () => `${rint(1, 4)} litter and ${rint(0, 6)} ambulatory patients, plus the AME team`,
    timeline: (pri) =>
      pri === 'P1' ? 'Time-critical patient - launch as soon as the team is aboard.' : 'Planned move - patients are stable, fly it smoothly.',
    build: (base) => fieldTask(base, 80, 240),
  },
  {
    kind: 'VIP Movement',
    category: 'Air mobility',
    roles: ['vip'],
    p1: 0.05,
    p2: 0.45,
    brief: ['Government movement - principal and party.', 'Special purpose flight, fixed arrival time.'],
    detail: (c) =>
      `Special purpose flight in the ${c.type} from ${c.base} to ${c.dest}, carrying the principal and party. Arrival time is fixed and public - plan the descent to make it to the minute, expect media on the apron, and brief the cabin crew on the arrival sequence. ${c.controller} for priority handling.`,
    hazards: ['Fixed arrival time, no room to be late or early', 'Apron congestion, media and ground party on the tarmac'],
    access: ['Terminal or VIP apron - ground party meets the aircraft'],
    lz: ['Sealed runway'],
    persons: () => 'Principal and party aboard',
    timeline: () => 'Wheels down to the minute - the whole movement is built around the arrival time.',
    build: (base) => fieldTask(base, 140, 440),
  },
  {
    kind: 'Navigation Exercise (NAVEX)',
    category: 'Flying training',
    roles: ['trainer'],
    weight: 3,
    p1: 0,
    p2: 0.25,
    brief: ['Low-level navigation exercise, dead reckoning and timing.', 'Cross-country navex with a diversion en route.'],
    detail: (c) =>
      `Navigation exercise in the ${c.type} out of ${c.base}. Route via the turning points toward ${c.place}, low level where the route allows, dead reckoning with a stopwatch and map only. Expect a diversion to ${c.dest} partway round - replan in the air, hold the fuel plan, and be back on time.`,
    hazards: ['Low level in a training area, other training aircraft on the same route', 'Terrain and wires at turning points, sun on the map'],
    access: ['N/A - navigation route'],
    lz: ['Recovery to base'],
    timeline: () => 'Booked sortie - airborne on the wave time.',
    build: (base) => {
      const brg = aoBearing(base, true);
      const c = project(base.lat, base.lon, brg, 40 + Math.random() * 110);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Formation Training Sortie',
    category: 'Flying training',
    roles: ['formation'],
    weight: 2,
    p1: 0,
    p2: 0.25,
    brief: ['Close and tactical formation in the training area.', 'Formation sortie - join, echelon, and a tail chase.'],
    detail: (c) =>
      `Formation sortie in the ${c.type}. Depart ${c.base} for ${c.area}, run the join, hold close formation through the sequence, then split to tactical and finish with a tail chase. Watch the lead's wing, watch the fuel, and re-join for a formation recovery. ${c.controller} for the area.`,
    hazards: ['Close formation - overtake and closure are the whole risk', 'Cloud in the block, other training traffic, student fatigue'],
    access: ['N/A - training area'],
    lz: ['Recovery to base - formation approach'],
    timeline: () => 'Booked airspace slot - lead is airborne first.',
    build: (base) => {
      const brg = aoBearing(base);
      const c = project(base.lat, base.lon, brg, 25 + Math.random() * 55);
      const alt = 8000 + Math.round(Math.random() * 8) * 1000;
      return {
        lat: c.lat,
        lon: c.lon,
        targets: [{ label: `Formation lead, ${alt} ft`, titleHint: 'prop', loop: true, holdUntilNm: 35, route: racetrack(c, 14, 6, alt, 220) }],
      };
    },
  },
  {
    kind: 'Instrument Flying Detail',
    category: 'Flying training',
    roles: ['trainer'],
    weight: 2,
    p1: 0,
    p2: 0.2,
    brief: ['Instrument detail - holds, procedural approaches, a go-around.', 'IF renewal: airways sector then approaches at the destination.'],
    detail: (c) =>
      `Instrument flying detail in the ${c.type}. Depart ${c.base} on an airways clearance, fly the sector to ${c.dest}, then a hold and two instrument approaches with a missed approach off the first. Full procedural, no shortcuts, and expect the instructor to fail something. ${c.controller} for the clearance.`,
    hazards: ['Under the hood or in cloud, instrument workload', 'Mixing with civil traffic at the destination, icing in the climb'],
    access: ['N/A - instrument training'],
    lz: ['Recovery to base'],
    timeline: () => 'Booked sortie and a booked approach slot at the destination.',
    build: (base) => fieldTask(base, 50, 170, false),
  },
];

/**
 * Who tasked it, and who is on the phone. Both used to come from one catch-all
 * list, so a close air support serial could be reported by "Movements" and a
 * search and rescue call could come from "Exercise Control" rather than the
 * rescue coordination centre that actually raises them.
 */
function raafSource(tpl: RaafTpl): string {
  if (tpl.roles.includes('sar')) return 'JRCC Australia';
  if (tpl.category === 'Air defence') return rand(['Air Defence', 'Sector Ops', 'the AOCC']);
  if (tpl.category === 'Flying training' || tpl.category === 'Air combat training')
    return rand(['Squadron Ops', 'the Duty Instructor', 'Wing Ops']);
  if (tpl.category === 'Air mobility') return rand(['Air Mobility Control Centre', 'the AOCC', 'Wing Ops']);
  return rand(['the AOCC', 'Exercise Control', 'HQ Air Command']);
}

function raafInformant(tpl: RaafTpl): string {
  if (tpl.roles.includes('sar')) return rand(['JRCC search mission coordinator', 'The RCC duty officer']);
  if (tpl.category === 'Air defence')
    return rand(['Sector controller', 'AOCC duty officer', 'Ground CRC', 'The fighter controller']);
  if (tpl.category === 'Flying training' || tpl.category === 'Air combat training')
    return rand(['Duty instructor', 'Squadron authoriser', 'The wave supervisor']);
  if (tpl.category === 'Air mobility') return rand(['Movements', 'The detachment commander', 'AOCC duty officer']);
  return rand(['The JTAC', 'Squadron Ops', 'AOCC duty officer', 'The exercise director']);
}

/** The other unit that matters to this task — not a random one from a list. */
function supportingUnit(tpl: RaafTpl): string {
  if (tpl.roles.includes('sar')) return rand(['Surface units tasked', 'Second search aircraft inbound', 'JRCC coordinating']);
  if (tpl.category === 'Air defence') return rand(['Wingman airborne', 'Tanker on the towline', 'AEW&C on station']);
  if (tpl.category === 'Air combat training' || tpl.category === 'Flying training')
    return rand(['Duty instructor authorising', 'Staff aircraft on the wave behind', 'Supervisor of flying on watch']);
  if (tpl.roles.includes('ame')) return rand(['AME team aboard', 'Ambulances booked both ends', 'Receiving hospital notified']);
  if (tpl.category === 'Air mobility') return rand(['Movements team at both ends', 'Ground handling booked', 'Load team on the ramp']);
  return rand(['JTAC on the ground', 'Range control open', 'Second pair on the wave behind']);
}

/**
 * Generate one RAAFv job. `near` biases toward a base within reach.
 *
 * The order matters: base first, then what that base can actually launch, then a
 * mission those aircraft can fly. Doing it the other way round is what used to
 * produce a Hercules flying a QRA scramble.
 */
export function generateRaafJob(near?: { lat: number; lon: number } | null): Job {
  // Bases that can actually launch: the home bases, plus any dry base the live
  // fleet shows a detachment sitting at. A dry base with nothing parked is a
  // destination, never a departure point.
  let bases = launchableBases();
  if (near) {
    const local = bases.filter((b) => rngNm(near.lat, near.lon, b.lat, b.lon) <= 420);
    bases = local.length
      ? local
      : [...HOME_BASES]
          .sort((a, b) => rngNm(near.lat, near.lon, a.lat, a.lon) - rngNm(near.lat, near.lon, b.lat, b.lon))
          .slice(0, 2);
  }
  // Weighted by base tempo: Williamtown and Amberley run most of RAAFv's flying,
  // and the Point Cook flying school should not generate as many sorties a day
  // as the largest operational base — which uniform selection had it doing.
  const base = ((): RaafBase => {
    // A stood-up detachment flies, but it is not a main operating base — tempo 0
    // (every dry base) becomes 1, against 7 for Williamtown.
    const weight = (b: RaafBase) => Math.max(1, b.tempo);
    const total = bases.reduce((s2, b) => s2 + weight(b), 0);
    let r = Math.random() * total;
    for (const b of bases) {
      r -= weight(b);
      if (r <= 0) return b;
    }
    return bases[bases.length - 1]!;
  })();

  // What can this base put in the air right now? With a crew centre key that is
  // the live fleet; without one it is the published order of battle.
  const here = availabilityAt(base);
  const can = (rs: Role[], have: Set<Role>) => rs.some((r) => have.has(r));
  const usable = RAAFV_TEMPLATES.filter((t) => can(t.roles, here.roles));
  // A base with nothing suitable parked (every airframe airborne, say) would
  // otherwise return no job at all — fall back to its resident squadrons.
  const resident = rosterRoles(base);
  const pool = usable.length ? usable : RAAFV_TEMPLATES.filter((t) => can(t.roles, resident));
  if (pool.length === 0) return generateRaafJob(null);

  const tpl = ((): RaafTpl => {
    const total = pool.reduce((s, t) => s + (t.weight ?? 1), 0);
    let r = Math.random() * total;
    for (const t of pool) {
      r -= t.weight ?? 1;
      if (r <= 0) return t;
    }
    return pool[pool.length - 1]!;
  })();

  // The specific airframe: a real tail number off the crew centre when we have
  // one, otherwise a resident squadron of the right type.
  const role = tpl.roles.find((r) => here.roles.has(r)) ?? tpl.roles.find((r) => resident.has(r)) ?? tpl.roles[0]!;
  const assigned = availabilityAt(base, role);
  const liveUnit = assigned.aircraft ? unitForAircraft(assigned.aircraft) : null;
  const local = unitsFor(base, role);
  const unit = liveUnit ?? rand(local.length ? local : base.units);
  const callsign = `${unit.callsign} ${rint(1, 4) * 10 + rint(1, 2)}`;

  const built = tpl.build(base);
  const where = aoPlaceName(base, built.lat, built.lon);
  const day = daypart();
  // Never the departure base: a navigation exercise out of Pearce was being
  // told to divert to Pearce.
  const destField = aerodromeNear(built.lat, built.lon, 140, false, base.ident) ?? aerodromeNear(base.lat, base.lon, 400, false, base.ident);
  const ctx: RaafCtx = {
    base: base.name,
    ident: base.ident,
    place: where.phrase,
    defended: nearestDefended(base.lat, base.lon, where.phrase),
    // Air defence tasking talks to the control and reporting units; everyone
    // else talks to the area centre. One shared list had Sector (Air Defence)
    // routing an aeromedical flight.
    controller: built.track
      ? built.track.centre
      : tpl.category === 'Air defence'
        ? rand(['Sector (Air Defence)', 'Eastern RADAR', 'Northern RADAR', 'the AOCC'])
        : rand(['Brisbane Centre', 'Melbourne Centre', 'the AOCC', 'the area controller']),
    roe: rand([
      'get a visual ID and shadow - no closer than 500 ft, no signals unless directed.',
      'ID covertly, then overtly signal and escort it clear.',
      'ID and query intentions by radio and light; escort, do not manoeuvre aggressively.',
      'ID, report the picture, and hold off until the fighter controller commits you.',
    ]),
    night: day.night,
    type: unit.type,
    squadron: unit.squadron,
    range: built.range ?? rangeFor(base).name,
    dest: built.dest ?? (destField ? `${destField.name} (${destField.icao})` : where.phrase),
    area: `the ${base.name.replace(/^(RAAFv Base |vDefence Establishment )/, '')} training area`,
    track: built.track ? `refuelling track ${built.track.name}` : 'the assigned towline',
    rvip: built.track?.rvip ?? 'the RVIP',
    rvcp: built.track?.rvcp ?? 'the RVCP',
    navChk: built.track?.navChk ?? 'the nav check point',
    exitPt: built.track?.exit ?? 'the exit point',
    block: built.track?.altitudes ?? 'assigned',
    freq: built.track?.freq ?? 'as assigned',
    anchor: built.anchor ?? 'the assigned point',
  };
  const jobRegion = regionAt(built.lat, built.lon, base.region);
  const x = Math.random();
  const priority: Priority = x < tpl.p1 ? 'P1' : x < tpl.p1 + tpl.p2 ? 'P2' : 'P3';
  const w = wx(day.night);
  const tgt = built.targets?.[0];

  const tail = assigned.aircraft?.registration;
  const units = [
    `${callsign} - ${unit.squadron} ${unit.type}${tail ? ` (${tail})` : ''}`,
    `${base.name} (${base.ident}) - base ops`,
    supportingUnit(tpl),
  ];

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    status: 'available',
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    phase: null,

    aircraftClass: 'fixed',
    priority,
    kind: tpl.kind,
    category: tpl.category,
    agency: `${unit.squadron} RAAF (${unit.type})`,
    callsign,

    lat: built.lat,
    lon: built.lon,
    // A flying training sortie happens in a training area, not an "area of
    // operations" — the label is what an operator scans the board by.
    place: `${tpl.offshore ? 'Offshore - ' : ''}${base.name} ${tpl.category === 'Flying training' ? 'training area' : 'AO'}, ${where.label}, ${jobRegion}`,
    region: jobRegion,
    latLon: dms(built.lat, built.lon),

    brief: `${day.label[0]!.toUpperCase()}${day.label.slice(1)}: ${rand(tpl.brief)}`,
    detail: [
      tpl.detail(ctx),
      tail ? `Airframe allocated: ${tail}, on the line at ${base.ident}.` : '',
      assigned.detachment ? `${unit.squadron} is deployed to ${base.name} — operating as a detachment.` : '',
      tgt?.squawk && tgt.squawk !== '0000' ? `Target squawk ${tgt.squawk}.` : tgt && tgt.squawk === '0000' ? 'Target is not squawking.' : '',
      tgt?.formation ? `Expect ${tgt.formation} aircraft in trail.` : '',
      w.note,
    ]
      .filter(Boolean)
      .join(' '),
    source: raafSource(tpl),
    informant: raafInformant(tpl),
    hazards: rand(tpl.hazards),
    persons: tpl.persons ? tpl.persons(ctx) : 'N/A - airborne task',
    access: rand(tpl.access),
    lz: rand(tpl.lz),
    units,
    weather: w.text,
    timeline: `Priority ${priority[1]} - ${tpl.timeline(priority)}`,
    channel: 'raafv',
    targets: built.targets,
    tasked: {
      type: unit.type,
      squadron: unit.squadron,
      registration: tail,
      homeBase: `${base.name} (${base.ident})`,
      detachment: assigned.detachment || undefined,
      source: tail ? 'crew-centre' : 'roster',
    },
  };
}
