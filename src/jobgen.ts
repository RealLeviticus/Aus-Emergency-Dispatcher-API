import { randomUUID } from 'node:crypto';

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

export type Hospital = { name: string; lat: number; lon: number };

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

// ---- real Australian hospital helipads (HEMS receiving sites) -------
// Approx. helipad coordinates. `ident` only where a public heliport code exists;
// otherwise the flight plan uses a User point at the real hospital position.
const HOSPITALS: (Hospital & { region: string })[] = [
  { name: 'The Alfred Hospital HLS, Melbourne', region: 'VIC', lat: -37.8464, lon: 144.9816 },
  { name: 'Royal Melbourne Hospital HLS', region: 'VIC', lat: -37.7991, lon: 144.9558 },
  { name: 'Royal Children’s Hospital HLS, Parkville', region: 'VIC', lat: -37.7951, lon: 144.9508 },
  { name: 'Monash Medical Centre HLS, Clayton', region: 'VIC', lat: -37.9214, lon: 145.1219 },
  { name: 'University Hospital Geelong HLS', region: 'VIC', lat: -38.1479, lon: 144.3486 },
  { name: 'Ballarat Base Hospital HLS', region: 'VIC', lat: -37.5522, lon: 143.8555 },
  { name: 'Bendigo Health HLS', region: 'VIC', lat: -36.7401, lon: 144.2967 },
  { name: 'Albury Wodonga Health HLS', region: 'VIC', lat: -36.0793, lon: 146.9179 },
  { name: 'Latrobe Regional Hospital HLS, Traralgon', region: 'VIC', lat: -38.1843, lon: 146.5072 },
  { name: 'South West Healthcare HLS, Warrnambool', region: 'VIC', lat: -38.3767, lon: 142.5033 },
  { name: 'Mildura Base Public Hospital HLS', region: 'VIC', lat: -34.1912, lon: 142.1562 },
  { name: 'Goulburn Valley Health HLS, Shepparton', region: 'VIC', lat: -36.3719, lon: 145.4012 },
  { name: 'Royal North Shore Hospital HLS, St Leonards', region: 'NSW', lat: -33.8237, lon: 151.1912 },
  { name: 'Westmead Hospital HLS', region: 'NSW', lat: -33.8029, lon: 150.9878 },
  { name: 'Liverpool Hospital HLS', region: 'NSW', lat: -33.9214, lon: 150.9243 },
  { name: 'Nepean Hospital HLS, Penrith', region: 'NSW', lat: -33.7588, lon: 150.7169 },
  { name: 'John Hunter Hospital HLS, Newcastle', region: 'NSW', lat: -32.9214, lon: 151.7016 },
  { name: 'Wollongong Hospital HLS', region: 'NSW', lat: -34.4251, lon: 150.8934 },
  { name: 'Canberra Hospital HLS, Garran', region: 'NSW', lat: -35.3437, lon: 149.1006 },
  { name: 'Orange Health Service HLS', region: 'NSW', lat: -33.2712, lon: 149.1042 },
  { name: 'Wagga Wagga Base Hospital HLS', region: 'NSW', lat: -35.1201, lon: 147.3539 },
  { name: 'Dubbo Base Hospital HLS', region: 'NSW', lat: -32.2529, lon: 148.6062 },
  { name: 'Tamworth Rural Referral Hospital HLS', region: 'NSW', lat: -31.0832, lon: 150.9293 },
  { name: 'Port Macquarie Base Hospital HLS', region: 'NSW', lat: -31.4419, lon: 152.8763 },
  { name: 'Coffs Harbour Health Campus HLS', region: 'NSW', lat: -30.2969, lon: 153.109 },
  { name: 'Lismore Base Hospital HLS', region: 'NSW', lat: -28.8213, lon: 153.2764 },
  { name: 'Griffith Base Hospital HLS', region: 'NSW', lat: -34.2807, lon: 146.0554 },
  { name: 'Princess Alexandra Hospital HLS, Brisbane', region: 'QLD', lat: -27.4988, lon: 153.0338 },
  { name: 'Royal Brisbane & Women’s Hospital HLS', region: 'QLD', lat: -27.4491, lon: 153.0281 },
  { name: 'Gold Coast University Hospital HLS, Southport', region: 'QLD', lat: -27.9581, lon: 153.3829 },
  { name: 'Sunshine Coast University Hospital HLS, Birtinya', region: 'QLD', lat: -26.762, lon: 153.107 },
  { name: 'Toowoomba Hospital HLS', region: 'QLD', lat: -27.5482, lon: 151.9388 },
  { name: 'Bundaberg Hospital HLS', region: 'QLD', lat: -24.8688, lon: 152.3512 },
  { name: 'Rockhampton Hospital HLS', region: 'QLD', lat: -23.3719, lon: 150.5168 },
  { name: 'Mackay Base Hospital HLS', region: 'QLD', lat: -21.1499, lon: 149.169 },
  { name: 'Townsville University Hospital HLS', region: 'QLD', lat: -19.3199, lon: 146.7621 },
  { name: 'Cairns Hospital HLS', region: 'QLD', lat: -16.9247, lon: 145.7688 },
  { name: 'Hervey Bay Hospital HLS', region: 'QLD', lat: -25.2908, lon: 152.8362 },
  { name: 'Royal Adelaide Hospital HLS', region: 'SA', lat: -34.9206, lon: 138.5876 },
  { name: 'Flinders Medical Centre HLS, Bedford Park', region: 'SA', lat: -35.0188, lon: 138.5669 },
  { name: 'Lyell McEwin Hospital HLS, Elizabeth Vale', region: 'SA', lat: -34.7124, lon: 138.6773 },
  { name: 'Mount Gambier Hospital HLS', region: 'SA', lat: -37.8258, lon: 140.7831 },
  { name: 'Port Augusta Hospital HLS', region: 'SA', lat: -32.5083, lon: 137.7744 },
  { name: 'Royal Perth Hospital HLS', region: 'WA', lat: -31.9531, lon: 115.8683 },
  { name: 'Fiona Stanley Hospital HLS, Murdoch', region: 'WA', lat: -32.067, lon: 115.8363 },
  { name: 'Sir Charles Gairdner Hospital HLS, Nedlands', region: 'WA', lat: -31.9727, lon: 115.8163 },
  { name: 'Bunbury Regional Hospital HLS', region: 'WA', lat: -33.3512, lon: 115.6432 },
  { name: 'Geraldton Health Campus HLS', region: 'WA', lat: -28.7863, lon: 114.6292 },
  { name: 'Kalgoorlie Health Campus HLS', region: 'WA', lat: -30.7662, lon: 121.4562 },
  { name: 'Broome Hospital HLS', region: 'WA', lat: -17.9602, lon: 122.2212 },
  { name: 'Hedland Health Campus HLS, Port Hedland', region: 'WA', lat: -20.3132, lon: 118.5932 },
  { name: 'Royal Hobart Hospital HLS', region: 'TAS', lat: -42.8809, lon: 147.3242 },
  { name: 'Launceston General Hospital HLS', region: 'TAS', lat: -41.4432, lon: 147.1462 },
  { name: 'North West Regional Hospital HLS, Burnie', region: 'TAS', lat: -41.0612, lon: 145.8872 },
  { name: 'Royal Darwin Hospital HLS, Tiwi', region: 'NT', lat: -12.4072, lon: 130.9182 },
  { name: 'Alice Springs Hospital HLS', region: 'NT', lat: -23.7622, lon: 133.8782 },
];

/** Nearest real hospital helipad to a point (used for the patient-transport leg). */
function nearestHospital(lat: number, lon: number): Hospital {
  let best = HOSPITALS[0]!;
  let bestD = Infinity;
  for (const h of HOSPITALS) {
    const d = rngNm(lat, lon, h.lat, h.lon);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return { name: best.name, lat: best.lat, lon: best.lon };
}

// ---- op templates ---------------------------------------------------

type DetailCtx = {
  loc: string;
  town: string;
  region: string;
  hospital?: string;
  night: boolean;
};

type Tpl = {
  kind: string;
  category: string;
  cls: AircraftClass;
  agencies: [string, string][]; // [name, callsign]
  /** relative weight in the pool (default 1) */
  weight?: number;
  p1: number;
  p2: number;
  transport?: boolean;
  offshore?: boolean;
  anchorKinds?: Anchor['kind'][];
  /** where the incident physically sits — controls coordinate placement */
  terrain: Terrain;
  /** setting phrases that agree with `terrain` (empty = use the town name) */
  settings: string[];
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
];

// Where each agency actually operates (`'*'` = national). Adjacent states can
// appear as a border-town exception.
const REGION_ADJ: Record<string, string[]> = {
  VIC: ['NSW', 'SA', 'TAS'],
  NSW: ['VIC', 'QLD', 'SA'],
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
  'NSW RFS Aviation': ['NSW'],
  'CFA / FRV Aircraft': ['VIC'],
  'Royal Flying Doctor Service': '*',
  'Police Aviation': '*',
  'National Aerial Firefighting': '*',
  'AMSA / JRCC Australia': '*',
  'JRCC Australia': '*',
  'Australian Border Force': '*',
  'Marine Rescue': '*',
  'National Parks / DBCA': '*',
  'Aerial Survey Operations': '*',
};

/** Pick an agency that actually covers this region (with a small border-town chance). */
function pickAgency(list: [string, string][], region: string): [string, string] {
  const home = list.filter((a) => {
    const r = AGENCY_REGIONS[a[0]];
    return r === '*' || (Array.isArray(r) && r.includes(region));
  });
  const adj = list.filter((a) => {
    const r = AGENCY_REGIONS[a[0]];
    return Array.isArray(r) && (REGION_ADJ[region] ?? []).some((x) => r.includes(x));
  });
  if (home.length && (!adj.length || Math.random() > 0.15)) return rand(home);
  if (adj.length) return rand(adj);
  return rand(home.length ? home : list);
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
  'National Parks / DBCA': ['Ranger 1', 'Ranger 4'],
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

const TEMPLATES: Tpl[] = [
  {
    kind: 'MVA with entrapment',
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
    kind: 'Medical retrieval — rural property',
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
    kind: 'Coastal / cliff rescue',
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
    kind: 'Swiftwater / flood rescue',
    category: 'Rescue / winch',
    cls: 'rotary',
    agencies: [['Westpac Life Saver Rescue', 'Lifesaver'], ['NSW Ambulance', 'Rescue'], ['RACQ LifeFlight Rescue', 'Rescue'], ['Ambulance Victoria', 'HEMS']],
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
    kind: 'Structure fire — persons reported',
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
    kind: 'Level crossing — train vs vehicle',
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
    kind: 'Bus / coach rollover — multi-casualty',
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
    kind: 'Search / offender containment',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [['Police Aviation', 'PolAir']],
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
    kind: 'Missing person — bushland search',
    category: 'Police aviation',
    cls: 'rotary',
    agencies: [['Police Aviation', 'PolAir'], ['National Parks / DBCA', 'Ranger'], ['AMSA / JRCC Australia', 'Rescue']],
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
  {
    kind: 'Marine rescue — winch',
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
    kind: 'Diving incident — decompression illness',
    category: 'Aeromedical',
    cls: 'rotary',
    agencies: [['RACQ LifeFlight Rescue', 'Rescue'], ['Westpac Life Saver Rescue', 'Lifesaver'], ['NSW Ambulance', 'Rescue']],
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
    kind: 'Envenomation — remote',
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
    kind: 'Powerline strike / electrocution',
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
    kind: 'Fire reconnaissance / crew insertion',
    category: 'Firefighting support',
    cls: 'rotary',
    agencies: [['NSW RFS Aviation', 'Firebird'], ['CFA / FRV Aircraft', 'Firebird'], ['National Parks / DBCA', 'Ranger']],
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
    kind: 'Storm damage — SES air support',
    category: 'Firefighting support',
    cls: 'rotary',
    agencies: [['Police Aviation', 'PolAir'], ['NSW RFS Aviation', 'Firebird'], ['National Parks / DBCA', 'Ranger']],
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
    kind: 'RFDS primary evacuation',
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
    kind: 'Neonatal / paediatric retrieval',
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
    kind: 'Obstetric flying squad',
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
    kind: 'Burns — inter-hospital transfer',
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
    kind: 'Inter-hospital transfer (fixed wing)',
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
    kind: 'Search and rescue — offshore',
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
    kind: 'Fire mapping / air attack supervision',
    category: 'Firefighting (fixed wing)',
    cls: 'fixed',
    agencies: [['National Aerial Firefighting', 'Bomber'], ['NSW RFS Aviation', 'Firebird'], ['Aerial Survey Operations', 'Survey']],
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
    kind: 'Maritime surveillance patrol',
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
    kind: 'Aerial survey / photography',
    category: 'Survey',
    cls: 'fixed',
    agencies: [['Aerial Survey Operations', 'Survey'], ['National Parks / DBCA', 'Ranger']],
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
  const tpl = pickTpl(TEMPLATES);
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
  const anchor = rand(pool.length ? pool : ANCHORS);
  const spot = placePoint(anchor, tpl.terrain);
  const lat = spot.lat;
  const lon = spot.lon;
  const [agencyName] = pickAgency(tpl.agencies, anchor.region);
  const csTmpl = tpl.agencies.find((a) => a[0] === agencyName)?.[1] ?? 'Rescue';
  const callsign = callsignFor(agencyName, csTmpl);
  const setting = tpl.settings.length ? rand(tpl.settings) : anchor.name;
  const loc =
    tpl.terrain === 'offshore'
      ? anchor.name
      : tpl.terrain === 'airstrip'
        ? `${setting} at ${anchor.name}`
        : `${setting} near ${anchor.name}`;

  const day = daypart();
  const w = wx(day.night);

  const x = Math.random();
  // A little escalation: night nudges retrieval/trauma toward P1.
  const p1 = tpl.p1 + (day.night && tpl.cas ? 0.08 : 0);
  const priority: Priority = x < p1 ? 'P1' : x < p1 + tpl.p2 ? 'P2' : 'P3';

  const transportTo: Hospital | undefined = tpl.transport && chance(0.92) ? nearestHospital(lat, lon) : undefined;
  const patient = tpl.cas ? makeCasualty(tpl.cas) : undefined;

  // Compose the briefing: template lead + patient + a complication + access + weather note.
  const compPool = [...(tpl.complications ?? []), ...COMPLICATIONS];
  const parts = [
    tpl.detail({ loc, town: anchor.name, region: anchor.region, hospital: transportTo?.name, night: day.night }),
    patient ? `Patient: ${patient}` : '',
    chance(0.7) ? rand(compPool) : '',
    tpl.terrain === 'offshore' || tpl.terrain === 'airstrip' ? '' : chance(0.7) ? rand(ACCESS_NOTES) : '',
    w.note,
  ].filter(Boolean);

  const eta = priority === 'P1' ? `Priority 1 — go now. Estimate ${rint(35, 75)} min on task.` : priority === 'P2' ? `Priority 2 — respond without delay. ~${rint(60, 110)} min on task.` : `Priority 3 — as tasking allows.`;

  const support = [
    'Road ambulance on scene',
    'Police en route',
    'Fire service on scene',
    'Local rescue unit responding',
    'SES road crew tasked',
    'Duty clinician on the line',
  ];

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
        : `${loc}, ${anchor.region}`,
    region: anchor.region,
    latLon: dms(lat, lon),

    brief: `${day.label[0]!.toUpperCase()}${day.label.slice(1)}: ${rand(tpl.brief)}`,
    detail: parts.join(' '),
    source: rand([`${agencyName} operations`, 'State health operations centre', 'Triple Zero (000)', 'State duty operations manager', 'Aeromedical coordination']),
    informant: rand(['On-scene road crew', 'Duty operations manager', 'Incident controller', 'Reporting person (mobile)', 'Referring hospital', 'Ground search coordinator']),
    hazards: rand(tpl.hazards),
    persons: rand(tpl.persons),
    access: rand(tpl.access),
    lz: rand(tpl.lz),
    units: [`${callsign} (tasked)`, ...support.sort(() => Math.random() - 0.5).slice(0, rint(1, 3))],
    weather: w.text,
    transportTo,
    patient,
    timeline: eta,
    channel: 'emergency',
  };
}

// ---- RAAFv (military) tasking -----------------------------------------

type RaafBase = { name: string; ident: string; lat: number; lon: number; region: string; sea: number };

const RAAF_BASES: RaafBase[] = [
  { name: 'RAAF Williamtown', ident: 'YWLM', lat: -32.795, lon: 151.834, region: 'NSW', sea: 100 },
  { name: 'RAAF Richmond', ident: 'YSRI', lat: -33.6, lon: 150.781, region: 'NSW', sea: 95 },
  { name: 'RAAF Amberley', ident: 'YAMB', lat: -27.64, lon: 152.712, region: 'QLD', sea: 95 },
  { name: 'RAAF Townsville', ident: 'YBTL', lat: -19.253, lon: 146.765, region: 'QLD', sea: 70 },
  { name: 'RAAF Tindal', ident: 'YPTN', lat: -14.521, lon: 132.378, region: 'NT', sea: 340 },
  { name: 'RAAF Darwin', ident: 'YPDN', lat: -12.415, lon: 130.887, region: 'NT', sea: 325 },
  { name: 'RAAF Pearce', ident: 'YPEA', lat: -31.668, lon: 116.015, region: 'WA', sea: 250 },
  { name: 'RAAF Learmonth', ident: 'YPLM', lat: -22.236, lon: 114.088, region: 'WA', sea: 280 },
  { name: 'RAAF East Sale', ident: 'YMES', lat: -38.099, lon: 147.149, region: 'VIC', sea: 190 },
  { name: 'RAAF Edinburgh', ident: 'YPED', lat: -34.702, lon: 138.621, region: 'SA', sea: 215 },
];

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

function nearestAnchorName(lat: number, lon: number): string {
  let best = ANCHORS[0]!;
  let d = Infinity;
  for (const a of ANCHORS) {
    const dd = rngNm(lat, lon, a.lat, a.lon);
    if (dd < d) {
      d = dd;
      best = a;
    }
  }
  return best.name;
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
function nearestDefended(lat: number, lon: number): string {
  let best = DEFENDED[0]!;
  let d = Infinity;
  for (const x of DEFENDED) {
    const dd = rngNm(lat, lon, x.lat, x.lon);
    if (dd < d) {
      d = dd;
      best = x;
    }
  }
  return best.name;
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
  const brg = Math.random() * 360;
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
};

type RaafTpl = {
  kind: string;
  category: string;
  cls: AircraftClass;
  agencies: [string, string][];
  weight?: number;
  p1: number;
  p2: number;
  offshore?: boolean;
  brief: string[];
  detail: (c: RaafCtx) => string;
  hazards: string[];
  access: string[];
  lz: string[];
  build: (base: RaafBase) => { lat: number; lon: number; targets?: AirTarget[] };
};

const FIGHTER_SQNS: [string, string][] = [
  ['No. 3 Squadron RAAF (F-35A)', 'Vector'],
  ['No. 77 Squadron RAAF (F-35A)', 'Magpie'],
  ['No. 75 Squadron RAAF (F-35A)', 'Dingo'],
  ['No. 1 Squadron RAAF (F/A-18F)', 'Rhino'],
  ['No. 6 Squadron RAAF (EA-18G)', 'Growler'],
];

const RAAFV_TEMPLATES: RaafTpl[] = [
  {
    kind: 'QRA scramble - intercept',
    category: 'Air defence',
    cls: 'fixed',
    agencies: FIGHTER_SQNS,
    weight: 4,
    p1: 0.9,
    p2: 0.1,
    brief: [
      'ALERT 5 - unidentified track inbound, no flight plan, no comms.',
      'Scramble - track of interest not responding to ATC.',
      'Fighters go - fast, no squawk, closing controlled airspace.',
    ],
    detail: (c) =>
      `Scramble from ${c.base}. An unidentified track is inbound from the direction of ${c.place} toward ${c.defended}. ${c.controller} has control. Run the intercept, get a visual ID, then ${c.roe} If it will not comply, be prepared to shoulder it away from ${c.defended}.`,
    hazards: ['High closure, wake turbulence, airliner density', 'Controlled airspace, night VID, other fighters on frequency'],
    access: ['N/A - airborne intercept'],
    lz: ['Recovery to base or a nominated divert'],
    build: (base) => intercept(base, chance(0.3) ? THREATS.raid! : THREATS.fast!),
  },
  {
    kind: 'QRA scramble - slow mover',
    category: 'Air defence',
    cls: 'fixed',
    agencies: FIGHTER_SQNS,
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
    build: (base) => intercept(base, rand([THREATS.light!, THREATS.uas!, THREATS.heli!])),
  },
  {
    kind: 'Comms-loss airliner shadow',
    category: 'Air defence',
    cls: 'fixed',
    agencies: FIGHTER_SQNS,
    weight: 2,
    p1: 0.7,
    p2: 0.3,
    brief: ['Airliner squawking 7600, no voice contact, on an airway.', 'Heavy jet NORDO - verify flight deck state.'],
    detail: (c) =>
      `An airliner on the airway near ${c.place} is squawking 7600 with no voice contact. ${c.controller} requests a discreet shadow. Close from behind and below, look through the flight deck windows for signs of life or a hijack indicator, relay what you see, and stay with it toward ${c.defended}. ${c.roe}`,
    hazards: ['Wake behind a heavy, passenger optics - stay discreet', 'Sun or night on the flight deck, TCAS RAs'],
    access: ['N/A - airborne shadow'],
    lz: ['Recovery once relieved'],
    build: (base) => intercept(base, THREATS.airliner!),
  },
  {
    kind: 'Combat air patrol - CAP station',
    category: 'Air defence',
    cls: 'fixed',
    agencies: FIGHTER_SQNS,
    weight: 2,
    p1: 0.15,
    p2: 0.5,
    brief: ['Hold the CAP station, be ready to commit.', 'Establish a defensive CAP over the exercise area.'],
    detail: (c) =>
      `Establish a CAP for ${c.defended} on the assigned station near ${c.place}. Fly the racetrack at the briefed height and airspeed, hold an accurate hack, manage fuel to your bingo, and be ready to commit on ${c.controller}. Relieved on station.`,
    hazards: ['Long time on station, fuel management, formation in the block', 'Weather and other CAP fighters'],
    access: ['N/A - CAP station'],
    lz: ['Recovery to base or the tanker'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 120);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Air combat training (DACT)',
    category: 'Air defence',
    cls: 'fixed',
    agencies: FIGHTER_SQNS,
    weight: 2,
    p1: 0.1,
    p2: 0.45,
    brief: ['1v1 to the merge in the training area.', 'Basic fighter manoeuvres with an adversary.'],
    detail: (c) =>
      `Proceed to the training area near ${c.place} for dissimilar air combat training. An adversary is holding on a racetrack - fight to the merge, keep it in the area, mind the floor and the deconfliction plan, and knock it off at your bingo.`,
    hazards: ['High-G, spatial disorientation, mid-air risk', 'Area floor and ceiling, cloud in the block'],
    access: ['N/A - training area'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
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
    kind: 'Air-to-air refuelling - tanker rendezvous',
    category: 'Air mobility',
    cls: 'fixed',
    agencies: [['No. 33 Squadron RAAF (KC-30A)', 'Dragon']],
    weight: 2,
    p1: 0.05,
    p2: 0.45,
    brief: ['Pre-planned AAR bracket, receivers inbound.', 'Towline established - join as receiver.'],
    detail: (c) =>
      `Proceed from ${c.base} to the AAR towline near ${c.place}. Join on the tanker as a receiver, fly the racetrack in close formation, take on fuel, then clear to the right and resume tasking. ${c.controller} has the block.`,
    hazards: ['Formation, wake, cloud in the block', 'Fuel state, other receivers on the boom'],
    access: ['N/A - airborne'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 90);
      return {
        lat: c.lat,
        lon: c.lon,
        targets: [{ label: 'KC-30A tanker, FL250', titleHint: 'heavy', loop: true, holdUntilNm: 70, route: racetrack(c, 36, 12, 25000, 290) }],
      };
    },
  },
  {
    kind: 'Transport / VIP escort',
    category: 'Air mobility',
    cls: 'fixed',
    agencies: [['No. 35 Squadron RAAF (C-27J)', 'Spartan'], ['No. 37 Squadron RAAF (C-130J)', 'Hercules'], ['No. 34 Squadron RAAF (BBJ)', 'Envoy']],
    weight: 2,
    p1: 0.1,
    p2: 0.4,
    brief: ['Escort a transport along the corridor to the FOB.', 'Shadow a VIP aircraft through the sector.'],
    detail: (c) =>
      `Depart ${c.base} and rendezvous with a transport routing toward ${c.place}. Escort it along the corridor, keep a visual watch either side, and hand it to the terminal controller. ${c.controller} has coordination.`,
    hazards: ['Speed mismatch, formation, terrain and weather in the corridor', 'Night formation join'],
    access: ['N/A - airborne'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
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
    kind: 'Airborne insertion - DZ overwatch',
    category: 'Air mobility',
    cls: 'fixed',
    agencies: [['No. 37 Squadron RAAF (C-130J)', 'Hercules'], ['No. 35 Squadron RAAF (C-27J)', 'Spartan']],
    p1: 0.1,
    p2: 0.4,
    brief: ['Escort the drop aircraft to the DZ and watch the run-in.', 'Overwatch a low-level static-line drop.'],
    detail: (c) =>
      `A drop aircraft will run in to the DZ near ${c.place} at low level and slow speed. Escort it to the release point, watch the run and the canopies, call any hazards, then shepherd it back up to height. ${c.controller} coordinating with the DZ party.`,
    hazards: ['Low level, low speed, sink behind the heavy', 'Canopies and jumpers in the air, wires near the DZ'],
    access: ['N/A - airborne'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
      const far = 60 + Math.random() * 80;
      const dz = project(base.lat, base.lon, brg, far);
      const run0 = project(dz.lat, dz.lon, (brg + 180) % 360, 18);
      const run2 = project(dz.lat, dz.lon, brg, 12);
      return {
        lat: dz.lat,
        lon: dz.lon,
        targets: [
          {
            label: 'Drop aircraft, 1200 ft, 130 kt',
            titleHint: 'heavy',
            holdUntilNm: 40,
            route: [p(run0, 6000, 210), p(dz, 1200, 130), p(run2, 1200, 130), p(project(run2.lat, run2.lon, brg, far), 9000, 240)],
          },
        ],
      };
    },
  },
  {
    kind: 'Close air support - JTAC',
    category: 'Strike / ISR',
    cls: 'fixed',
    agencies: [['No. 1 Squadron RAAF (F/A-18F)', 'Rhino'], ['No. 75 Squadron RAAF (F-35A)', 'Dingo'], ['No. 4 Squadron RAAF (FAC)', 'Havoc']],
    p1: 0.2,
    p2: 0.5,
    brief: ['Check in with the JTAC, hold the wheel, be ready for a 9-line.', 'CAS on-call over the ground scheme of manoeuvre.'],
    detail: (c) =>
      `Transit to the CAS keyhole near ${c.place} and check in with the JTAC. Set up a wheel at the briefed height, build a picture of the friendly and target locations, read back the 9-line, and remain on-station to your bingo. ${c.controller} for airspace.`,
    hazards: ['Terrain masking, small-arms threat envelope, other CAS aircraft', 'Density altitude, dust, smoke on the target'],
    access: ['N/A - CAS keyhole'],
    lz: ['Recovery to base or the tanker'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 50 + Math.random() * 110);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Tactical reconnaissance run',
    category: 'Strike / ISR',
    cls: 'fixed',
    agencies: [['No. 75 Squadron RAAF (F-35A)', 'Dingo'], ['No. 1 Squadron RAAF (F/A-18F)', 'Rhino']],
    p1: 0.1,
    p2: 0.4,
    brief: ['Single fast pass over the target for imagery.', 'Low-level recon of the coastal strip.'],
    detail: (c) =>
      `Fly a tactical reconnaissance run over the objective near ${c.place}. Ingress low and fast on the briefed heading, hold the line and speed through the target for the sensor, one pass only, then egress and climb. ${c.controller} for deconfliction.`,
    hazards: ['Very low level at high speed, wires and towers, bird strike', 'One-pass discipline - no re-attacks'],
    access: ['N/A - recon track'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 120);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Maritime patrol - surface picture',
    category: 'ISR / maritime',
    cls: 'fixed',
    agencies: [['No. 11 Squadron RAAF (P-8A)', 'Poseidon'], ['No. 10 Squadron RAAF (P-8A)', 'Poseidon']],
    weight: 2,
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    brief: ['Build the surface picture in the patrol box.', 'Investigate an AIS-dark contact offshore.'],
    detail: (c) =>
      `Transit from ${c.base} to the maritime patrol box offshore from ${c.place}. Run the search pattern, log every contact with position, course and speed, photograph anything of interest, and stay outside 500 ft of vessels unless directed. ${c.controller} for the area.`,
    hazards: ['Low level over water, fatigue, birds', 'Weather building offshore, oil-rig traffic'],
    access: ['N/A - patrol box'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = base.sea + (Math.random() - 0.5) * 40;
      const c = project(base.lat, base.lon, brg, 120 + Math.random() * 180);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Sovereignty patrol - northern approaches',
    category: 'ISR / maritime',
    cls: 'fixed',
    agencies: [['No. 11 Squadron RAAF (P-8A)', 'Poseidon'], ['No. 2 Squadron RAAF (E-7A)', 'Wedgetail']],
    p1: 0.1,
    p2: 0.4,
    offshore: true,
    brief: ['Patrol the northern approaches, report all air and surface tracks.', 'Presence patrol along the sea-air gap.'],
    detail: (c) =>
      `Patrol the northern approaches out of ${c.base}. Sweep the assigned lane toward the sea-air gap, correlate every air and surface track, investigate anything unusual, and report to ${c.controller}. Long tasking - manage crew and fuel.`,
    hazards: ['Very long endurance, remote diversion options', 'Tropical weather, other patrol assets'],
    access: ['N/A - patrol lane'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = base.sea + (Math.random() - 0.5) * 30;
      const c = project(base.lat, base.lon, brg, 180 + Math.random() * 220);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'ISR orbit - area of operations',
    category: 'ISR / maritime',
    cls: 'fixed',
    agencies: [['No. 2 Squadron RAAF (E-7A)', 'Wedgetail']],
    p1: 0.05,
    p2: 0.35,
    brief: ['Establish an ISR / AEW&C orbit over the AO.', 'Provide the recognised air picture for the exercise.'],
    detail: (c) =>
      `Depart ${c.base} and set up an AEW&C orbit over the area near ${c.place}. Build and pass the recognised air picture, control the fighters and the tanker, and remain on station until relieved. ${c.controller} takes hand-over.`,
    hazards: ['Long endurance, other high-level traffic', 'Weather and turbulence at height'],
    access: ['N/A - orbit'],
    lz: ['Recovery to base'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 60 + Math.random() * 140);
      return { lat: c.lat, lon: c.lon };
    },
  },
  {
    kind: 'Aeromedical evacuation (mil)',
    category: 'Air mobility',
    cls: 'fixed',
    agencies: [['No. 36 Squadron RAAF (C-17A)', 'Stallion'], ['No. 37 Squadron RAAF (C-130J)', 'Hercules']],
    p1: 0.4,
    p2: 0.45,
    brief: ['Strategic AME move of casualties to a major hospital.', 'Repatriate patients from a forward location.'],
    detail: (c) =>
      `Position ${c.base}, load the AME team and litter patients near ${c.place}, and transit to the receiving hospital. Smooth handling, cabin altitude restriction for the head-injury patients, ambulances both ends. ${c.controller} for routing.`,
    hazards: ['Cabin altitude limits, patient deterioration in flight', 'Long tasking, night arrival'],
    access: ['Airfield, ambulances airside'],
    lz: ['Sealed runway'],
    build: (base) => {
      const brg = Math.random() * 360;
      const c = project(base.lat, base.lon, brg, 80 + Math.random() * 160);
      return { lat: c.lat, lon: c.lon };
    },
  },
];

/** Generate one RAAFv job. `near` biases toward a RAAF base within reach. */
export function generateRaafJob(near?: { lat: number; lon: number } | null): Job {
  let bases = RAAF_BASES;
  if (near) {
    const local = bases.filter((b) => rngNm(near.lat, near.lon, b.lat, b.lon) <= 420);
    bases = local.length
      ? local
      : [...RAAF_BASES]
          .sort((a, b) => rngNm(near.lat, near.lon, a.lat, a.lon) - rngNm(near.lat, near.lon, b.lat, b.lon))
          .slice(0, 2);
  }
  const base = rand(bases);
  const tpl = ((): RaafTpl => {
    const total = RAAFV_TEMPLATES.reduce((s, t) => s + (t.weight ?? 1), 0);
    let r = Math.random() * total;
    for (const t of RAAFV_TEMPLATES) {
      r -= t.weight ?? 1;
      if (r <= 0) return t;
    }
    return RAAFV_TEMPLATES[RAAFV_TEMPLATES.length - 1]!;
  })();
  const built = tpl.build(base);
  const [agency, cs] = rand(tpl.agencies);
  const callsign = `${cs} ${rint(1, 4) * 10 + rint(1, 2)}`;
  const place = nearestAnchorName(built.lat, built.lon);
  const day = daypart();
  const ctx: RaafCtx = {
    base: base.name,
    ident: base.ident,
    place,
    defended: nearestDefended(built.lat, built.lon),
    controller: rand(['Sector (Air Defence)', 'Eastern RADAR', 'Northern RADAR', 'Brisbane Centre', 'Melbourne Centre', 'the AOCC']),
    roe: rand([
      'get a visual ID and shadow - no closer than 500 ft, no signals unless directed.',
      'ID covertly, then overtly signal and escort it clear.',
      'ID and query intentions by radio and light; escort, do not manoeuvre aggressively.',
      'ID, report the picture, and hold off until the fighter controller commits you.',
    ]),
    night: day.night,
  };
  const x = Math.random();
  const priority: Priority = x < tpl.p1 ? 'P1' : x < tpl.p1 + tpl.p2 ? 'P2' : 'P3';
  const w = wx(day.night);
  const tgt = built.targets?.[0];

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
    agency,
    callsign,

    lat: built.lat,
    lon: built.lon,
    place: `${tpl.offshore ? 'Offshore - ' : ''}${base.name} AO, ${place}, ${base.region}`,
    region: base.region,
    latLon: dms(built.lat, built.lon),

    brief: `${day.label[0]!.toUpperCase()}${day.label.slice(1)}: ${rand(tpl.brief)}`,
    detail: [
      tpl.detail(ctx),
      tgt?.squawk && tgt.squawk !== '0000' ? `Target squawk ${tgt.squawk}.` : tgt && tgt.squawk === '0000' ? 'Target is not squawking.' : '',
      tgt?.formation ? `Expect ${tgt.formation} aircraft in trail.` : '',
      w.note,
    ]
      .filter(Boolean)
      .join(' '),
    source: rand(['Air Defence', 'Sector Ops', 'AOCC', 'Exercise Control', 'HQ Air Command']),
    informant: rand(['Sector controller', 'AOCC duty officer', 'Ground CRC', 'ROC', 'The fighter controller']),
    hazards: rand(tpl.hazards),
    persons: 'N/A - airborne task',
    access: rand(tpl.access),
    lz: rand(tpl.lz),
    units: [`${callsign} (tasked)`, `${base.ident}`, rand(['Wingman airborne', 'Tanker on the towline', 'AEW&C on station', 'SAR alert crew held'])],
    weather: w.text,
    timeline: priority === 'P1' ? 'Priority 1 - ALERT 5, get airborne now.' : `Priority ${priority[1]} - brief and go.`,
    channel: 'raafv',
    targets: built.targets,
  };
}
