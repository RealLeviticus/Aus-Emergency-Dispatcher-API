/**
 * Where the RAAFv fleet actually is, right now.
 *
 * RAAFv's crew centre (crew.raafvirtual.org) runs phpVMS v7, which tracks a
 * current location for every airframe. That is what lets tasking name a real
 * aeroplane at a real base instead of inventing one:
 *
 *   GET /api/airports/hubs   PUBLIC   the nine bases RAAFv actually operates from
 *   GET /api/acars           PUBLIC   who is airborne right now, and where
 *   GET /api/fleet           KEY      every airframe, its type, its hub, and the
 *                                     airport it is currently parked at
 *
 * The first two need nothing. The third needs a crew centre API key in
 * `PHPVMS_API_KEY` — any pilot's key works, but use a dedicated one so a member
 * leaving does not take fleet data with them. Without it we fall back to the
 * static order of battle below, which is taken from RAAFv's own squadrons and
 * bases pages, so tasking stays correct — it just cannot quote a tail number.
 *
 * Everything here is best-effort: no call throws, no call blocks generation, and
 * a stale snapshot is always preferred to no snapshot.
 */

const PHPVMS_URL = (process.env.PHPVMS_URL ?? 'https://crew.raafvirtual.org').replace(/\/+$/, '');
const PHPVMS_API_KEY = process.env.PHPVMS_API_KEY ?? '';

/**
 * What an airframe can be tasked to do. Templates ask for a role; a base offers
 * the roles its parked aircraft can fly. That pairing is the whole point — it is
 * what stops a QRA scramble being generated at a base that only has Hercules.
 */
export type Role =
  | 'qra' // quick reaction alert / intercept
  | 'cap' // combat air patrol
  | 'dact' // dissimilar air combat training
  | 'cas' // close air support
  | 'recon' // tactical reconnaissance
  | 'fac' // forward air control
  | 'aar' // air-to-air refuelling (the tanker)
  | 'transport' // scheduled passenger / freight between bases
  | 'tactical' // airlift into a bare or unsurfaced strip
  | 'airdrop' // paratroop or store drop
  | 'ame' // aeromedical evacuation
  | 'vip' // government / VIP movement
  | 'maritime' // maritime patrol, surface picture
  | 'sar' // search and rescue
  | 'aewc' // airborne early warning and control
  | 'trainer' // ab initio and advanced flying training
  | 'formation' // sorties flown as a pair or a section
  | 'lif'; // lead-in fighter (Hawk) — training that fights

/** One flying unit: the squadron, what it flies, and what it can be given. */
export type Unit = {
  /** as it should read in a brief */
  squadron: string;
  /** type as RAAFv lists it */
  type: string;
  /**
   * How to recognise this unit's airframes in the crew centre fleet, most
   * reliable first.
   *
   * `sqn` is the token RAAFv puts in the subfleet name — "F35A | v75SQN",
   * "HAWK | v79SQN". That is the only thing that separates v1SQN from v6SQN,
   * whose aircraft BOTH report icao `F18S`, and it is how a tail number gets
   * attributed to the right squadron rather than the first one flying the type.
   *
   * `icao` is the type designator the aircraft actually reports, and `keys` are
   * distinctive words in the aircraft or subfleet name — the backstop for an
   * airframe in a subfleet that is not named after a squadron.
   */
  sqn?: string;
  icao: string[];
  keys: string[];
  /** radio callsign word */
  callsign: string;
  roles: Role[];
};

export type Base = {
  name: string;
  ident: string;
  lat: number;
  lon: number;
  region: string;
  /** true bearing from the base toward open water */
  sea: number;
  /** units permanently based here (empty for a dry base) */
  units: Unit[];
  /**
   * How much tasking this base generates, relative to the others. Uniform
   * selection gave the Point Cook flying school as many sorties a day as
   * Amberley, which is not what either base looks like.
   */
  tempo: number;
  /**
   * A "dry base" in RAAFv's own words: no resident flying squadron, stood up as
   * a detachment when air mobility puts one there. Tasking uses these as
   * destinations and deployment locations, never as the home base of a scramble.
   */
  dry?: boolean;
};

// ---- RAAFv order of battle -------------------------------------------
// Source: raafvirtual.org/squadrons.php and /bases.php, cross-checked against
// the crew centre's own hub list (GET /api/airports/hubs). This is deliberately
// RAAFv's ORBAT and not the real RAAF's: v6SQN flies the F/A-18F here, and
// there is no v10SQN, no Darwin-based fighter squadron and no rotary wing.

type TypeDef = Pick<Unit, 'type' | 'icao' | 'keys' | 'roles'>;

const F35: TypeDef = {
  type: 'F-35A Lightning II',
  icao: ['F35', 'F35A'],
  keys: ['f-35', 'f35', 'lightning'],
  roles: ['qra', 'cap', 'dact', 'cas', 'recon', 'formation'],
};
const RHINO: TypeDef = {
  type: 'F/A-18F Super Hornet',
  icao: ['F18S', 'F18', 'FA18', 'F18F'],
  keys: ['f/a-18f', 'rhino', 'super hornet'],
  roles: ['qra', 'cap', 'dact', 'cas', 'recon', 'formation'],
};
/**
 * The Growler is its own aeroplane, not a Super Hornet. RAAFv's squadron page
 * lists v6SQN as "F-18F", but their fleet is unambiguous: A46-series tails,
 * named "E/A-18G Growler". Electronic attack is a support role — it does not
 * hold the alert or fly close air support.
 */
const GROWLER: TypeDef = {
  type: 'EA-18G Growler',
  icao: ['F18S', 'EA18'],
  keys: ['growler', 'e/a-18g', 'ea-18g'],
  roles: ['dact', 'cap', 'recon', 'formation'],
};
const HAWK: TypeDef = {
  type: 'Hawk 127',
  icao: ['HAWK', 'HDH'],
  keys: ['hawk'],
  roles: ['lif', 'dact', 'cas', 'trainer', 'formation'],
};
const PC21: TypeDef = {
  type: 'PC-21',
  icao: ['PC21'],
  keys: ['pc-21', 'pc21', 'pilatus'],
  roles: ['trainer', 'formation'],
};
/** Same airframe, different job: 4SQN are the forward air controllers. */
const PC21_FAC: TypeDef = { ...PC21, roles: ['fac', 'trainer', 'formation'] };

export const RAAFV_BASES: Base[] = [
  {
    name: 'RAAFv Base Williamtown',
    ident: 'YWLM',
    lat: -32.795,
    lon: 151.834,
    region: 'NSW',
    sea: 100,
    tempo: 7,
    units: [
      { squadron: 'No. 3 Squadron', sqn: 'v3sqn', callsign: 'Vector', ...F35 },
      { squadron: 'No. 77 Squadron', sqn: 'v77sqn', callsign: 'Magpie', ...F35 },
      {
        squadron: 'No. 2 Operational Conversion Unit',
        sqn: 'v2ocu',
        callsign: 'Talon',
        ...F35,
        roles: ['dact', 'cap', 'cas', 'recon', 'formation'],
      },
      {
        squadron: 'No. 2 Squadron',
        sqn: 'v2sqn',
        type: 'E-7A Wedgetail',
        icao: ['E737', 'E7', 'E7A'],
        keys: ['e-7', 'wedgetail'],
        callsign: 'Wedgetail',
        roles: ['aewc'],
      },
      { squadron: 'No. 4 Squadron', sqn: 'v4sqn', callsign: 'Havoc', ...PC21_FAC },
      { squadron: 'No. 76 Squadron', sqn: 'v76sqn', callsign: 'Vampire', ...HAWK },
    ],
  },
  {
    name: 'RAAFv Base Amberley',
    ident: 'YAMB',
    lat: -27.64,
    lon: 152.712,
    region: 'QLD',
    sea: 95,
    tempo: 6,
    units: [
      { squadron: 'No. 1 Squadron', sqn: 'v1sqn', callsign: 'Rhino', ...RHINO },
      { squadron: 'No. 6 Squadron', sqn: 'v6sqn', callsign: 'Growler', ...GROWLER },
      {
        squadron: 'No. 33 Squadron',
        sqn: 'v33sqn',
        type: 'KC-30A MRTT',
        icao: ['A332', 'A330', 'KC30'],
        keys: ['kc-30', 'kc30', 'mrtt', 'a330'],
        callsign: 'Dragon',
        roles: ['aar', 'transport', 'ame'],
      },
      {
        squadron: 'No. 35 Squadron',
        sqn: 'v35sqn',
        type: 'C-27J Spartan',
        icao: ['C27J', 'C27'],
        keys: ['c-27', 'c27', 'spartan'],
        callsign: 'Spartan',
        roles: ['transport', 'tactical', 'airdrop', 'ame'],
      },
      {
        squadron: 'No. 36 Squadron',
        sqn: 'v36sqn',
        type: 'C-17A Globemaster III',
        icao: ['C17A', 'C17'],
        keys: ['c-17', 'c17', 'globemaster'],
        callsign: 'Stallion',
        roles: ['transport', 'tactical', 'ame', 'airdrop'],
      },
    ],
  },
  {
    name: 'RAAFv Base Richmond',
    ident: 'YSRI',
    lat: -33.6,
    lon: 150.781,
    region: 'NSW',
    sea: 95,
    tempo: 3,
    units: [
      {
        squadron: 'No. 37 Squadron',
        sqn: 'v37sqn',
        type: 'C-130J Hercules',
        icao: ['C30J', 'C130'],
        keys: ['c-130', 'c130', 'hercules'],
        callsign: 'Trader',
        roles: ['transport', 'tactical', 'airdrop', 'ame', 'sar'],
      },
    ],
  },
  {
    name: 'RAAFv Base Tindal',
    ident: 'YPTN',
    lat: -14.521,
    lon: 132.378,
    region: 'NT',
    sea: 340,
    tempo: 3,
    units: [{ squadron: 'No. 75 Squadron', sqn: 'v75sqn', callsign: 'Dingo', ...F35 }],
  },
  {
    name: 'RAAFv Base Edinburgh',
    ident: 'YPED',
    lat: -34.702,
    lon: 138.621,
    region: 'SA',
    sea: 215,
    tempo: 3,
    units: [
      {
        squadron: 'No. 11 Squadron',
        sqn: 'v11sqn',
        type: 'P-8A Poseidon',
        icao: ['P8', 'P8A'],
        keys: ['p-8', 'p8a', 'poseidon'],
        callsign: 'Poseidon',
        roles: ['maritime', 'sar'],
      },
    ],
  },
  {
    name: 'RAAFv Base Pearce',
    ident: 'YPEA',
    lat: -31.668,
    lon: 116.015,
    region: 'WA',
    sea: 250,
    tempo: 3,
    units: [
      { squadron: 'No. 79 Squadron', sqn: 'v79sqn', callsign: 'Mustang', ...HAWK },
      { squadron: 'No. 2 Flying Training School (det)', sqn: 'v2fts', callsign: 'Rocket', ...PC21 },
    ],
  },
  {
    name: 'RAAFv Base East Sale',
    ident: 'YMES',
    lat: -38.099,
    lon: 147.149,
    region: 'VIC',
    sea: 190,
    tempo: 5,
    units: [
      { squadron: 'No. 1 Flying Training School', sqn: 'v1fts', callsign: 'Foxtrot', ...PC21 },
      { squadron: 'No. 2 Flying Training School', sqn: 'v2fts', callsign: 'Rocket', ...PC21 },
      {
        squadron: 'No. 32 Squadron',
        sqn: 'v32sqn',
        type: 'King Air 350',
        icao: ['B350', 'BE20'],
        keys: ['king air', 'b350', 'b350i'],
        callsign: 'Bandit',
        roles: ['trainer', 'transport'],
        /** no formation: multi-engine students fly it single-ship */
      },
    ],
  },
  {
    name: 'vDefence Establishment Fairbairn',
    ident: 'YSCB',
    lat: -35.307,
    lon: 149.195,
    region: 'ACT',
    sea: 110,
    tempo: 2,
    units: [
      {
        squadron: 'No. 34 Squadron',
        type: 'Boeing 737 BBJ',
        // B38M, not B737: RAAFv's BBJ is a MAX airframe (A62-series tails).
        icao: ['B38M', 'B737', 'B73X', 'BBJ'],
        keys: ['bbj', 'business jet'],
        callsign: 'Envoy',
        roles: ['vip'],
      },
      {
        squadron: 'No. 34 Squadron (Falcon flight)',
        sqn: 'v34sqn',
        type: 'Dassault Falcon 7X',
        icao: ['FA7X', 'F7X'],
        keys: ['falcon'],
        callsign: 'Envoy',
        roles: ['vip'],
      },
    ],
  },
  {
    name: 'RAAFv Base Point Cook',
    ident: 'YMPC',
    lat: -37.932,
    lon: 144.753,
    region: 'VIC',
    sea: 140,
    tempo: 2,
    units: [
      {
        squadron: 'Elementary Flying Training School',
        type: 'Diamond DA-40 NG',
        icao: ['DA40', 'DA42'],
        keys: ['da-40', 'da40', 'diamond'],
        callsign: 'Cadet',
        roles: ['trainer'],
      },
    ],
  },

  // --- dry bases: no resident squadron, stood up as a detachment ---------
  { name: 'RAAFv Base Darwin', ident: 'YPDN', lat: -12.415, lon: 130.887, region: 'NT', sea: 325, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Townsville', ident: 'YBTL', lat: -19.253, lon: 146.765, region: 'QLD', sea: 70, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Learmonth', ident: 'YPLM', lat: -22.236, lon: 114.088, region: 'WA', sea: 280, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Curtin', ident: 'YCIN', lat: -17.581, lon: 123.828, region: 'WA', sea: 315, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Scherger', ident: 'YBWP', lat: -12.624, lon: 142.087, region: 'QLD', sea: 270, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Woomera', ident: 'YPWR', lat: -31.144, lon: 136.817, region: 'SA', sea: 170, tempo: 0, units: [], dry: true },
  { name: 'RAAFv Base Wagga Wagga', ident: 'YSWG', lat: -35.165, lon: 147.466, region: 'NSW', sea: 150, tempo: 0, units: [], dry: true },
];

export const HOME_BASES = RAAFV_BASES.filter((b) => !b.dry);

/** Every role someone could be tasked with from this base, per the ORBAT. */
export function rosterRoles(base: Base): Set<Role> {
  const out = new Set<Role>();
  for (const u of base.units) for (const r of u.roles) out.add(r);
  return out;
}

// ---- live fleet ------------------------------------------------------

export type FleetAircraft = {
  /** tail number as the crew centre holds it */
  registration: string;
  name: string;
  /** ICAO type designator, upper-cased */
  icao: string;
  /** where it is RIGHT NOW (ICAO), or null if the crew centre does not say */
  at: string | null;
  /** its home base (ICAO) */
  home: string | null;
  /** flying a live flight this second — not available to be tasked */
  airborne: boolean;
  /**
   * phpVMS says so itself: `status` 'A' is active (anything else is in
   * maintenance, stored or retired) and `state` 0 is parked. Between them these
   * are more reliable than the live-flight list, which only sees a sortie once
   * ACARS is connected.
   */
  serviceable: boolean;
  inUse: boolean;
  subfleet: string | null;
};

export type FleetSnapshot = {
  fetchedAt: number;
  /** 'crew-centre' when the numbers are live, 'roster' when we are guessing */
  source: 'crew-centre' | 'roster';
  aircraft: FleetAircraft[];
  /** how many are airborne right now */
  airborne: number;
  /** why we fell back, when we did */
  note?: string;
};

const EMPTY: FleetSnapshot = { fetchedAt: 0, source: 'roster', aircraft: [], airborne: 0, note: 'not fetched yet' };

const FLEET_TTL_MS = 10 * 60_000;
const ACARS_TTL_MS = 60_000;

let snapshot: FleetSnapshot = EMPTY;
let inFlight: Promise<FleetSnapshot> | null = null;

async function getJson(path: string, withKey: boolean): Promise<unknown | null> {
  try {
    const res = await fetch(`${PHPVMS_URL}${path}`, {
      headers: {
        accept: 'application/json',
        ...(withKey && PHPVMS_API_KEY ? { 'X-API-KEY': PHPVMS_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** phpVMS paginates on `meta.next_page`; walk it, but never forever. */
async function getAllPages(path: string, withKey: boolean, cap = 10): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= cap; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = (await getJson(`${path}${sep}page=${page}`, withKey)) as
      | { data?: unknown[]; meta?: { next_page?: number | string | null } }
      | null;
    if (!body?.data?.length) break;
    out.push(...body.data);
    if (!body.meta?.next_page) break;
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

/**
 * Pull one aircraft out of whatever shape the crew centre hands us. phpVMS
 * returns aircraft nested under subfleets on /api/fleet, and flat elsewhere, so
 * this is deliberately forgiving — a field we cannot read is null, not a throw.
 */
function readAircraft(raw: unknown, subfleet: string | null): FleetAircraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const registration = str(a.registration) ?? str(a.tail_number) ?? str(a.name);
  if (!registration) return null;
  const type = a.subfleet && typeof a.subfleet === 'object' ? (a.subfleet as Record<string, unknown>) : null;
  const status = str(a.status);
  const state = typeof a.state === 'number' ? a.state : Number(str(a.state) ?? 0);
  return {
    registration,
    name: str(a.name) ?? registration,
    icao: (str(a.icao) ?? str(type?.type) ?? '').toUpperCase(),
    at: str(a.airport_id)?.toUpperCase() ?? null,
    home: str(a.hub_id)?.toUpperCase() ?? null,
    airborne: false,
    // An absent status is treated as serviceable: a VA that does not track
    // maintenance should not end up with a grounded fleet.
    serviceable: !status || status.toUpperCase() === 'A',
    inUse: Number.isFinite(state) && state !== 0,
    subfleet: subfleet ?? str(type?.name),
  };
}

/** Tail numbers that are airborne on a live flight this second. */
async function liveTails(): Promise<Set<string>> {
  const body = (await getJson('/api/acars', false)) as { data?: unknown[] } | null;
  const out = new Set<string>();
  for (const f of body?.data ?? []) {
    const flight = f as Record<string, unknown>;
    const ac = flight.aircraft as Record<string, unknown> | undefined;
    const reg = str(ac?.registration) ?? str(ac?.tail_number);
    if (reg) out.add(reg.toUpperCase());
  }
  return out;
}

async function refresh(): Promise<FleetSnapshot> {
  const [rawSubfleets, airborne] = await Promise.all([
    PHPVMS_API_KEY ? getAllPages('/api/fleet', true) : Promise.resolve<unknown[]>([]),
    liveTails().catch(() => new Set<string>()),
  ]);

  const aircraft: FleetAircraft[] = [];
  for (const sf of rawSubfleets) {
    const s = sf as Record<string, unknown>;
    const name = str(s.name) ?? str(s.type);
    // /api/fleet nests aircraft under each subfleet; tolerate a flat list too.
    const list = Array.isArray(s.aircraft) ? s.aircraft : [sf];
    for (const item of list) {
      const ac = readAircraft(item, name);
      if (ac) {
        ac.airborne = airborne.has(ac.registration.toUpperCase());
        aircraft.push(ac);
      }
    }
  }

  if (aircraft.length === 0) {
    return {
      fetchedAt: Date.now(),
      source: 'roster',
      aircraft: [],
      airborne: airborne.size,
      note: PHPVMS_API_KEY
        ? 'the crew centre returned no fleet data — tasking is using the static order of battle'
        : 'set PHPVMS_API_KEY to read live fleet positions; tasking is using the static order of battle',
    };
  }

  return {
    fetchedAt: Date.now(),
    source: 'crew-centre',
    aircraft,
    airborne: aircraft.filter((a) => a.airborne).length,
  };
}

/**
 * The cached snapshot, refreshing in the background when it goes stale.
 * Never throws and never blocks: a caller mid-generation gets whatever we have.
 */
export function currentFleet(): FleetSnapshot {
  const age = Date.now() - snapshot.fetchedAt;
  const ttl = snapshot.source === 'crew-centre' ? FLEET_TTL_MS : ACARS_TTL_MS;
  if (age > ttl && !inFlight) {
    inFlight = refresh()
      .then((s) => {
        snapshot = s;
        return s;
      })
      .catch(() => snapshot)
      .finally(() => {
        inFlight = null;
      });
  }
  return snapshot;
}

/** Await the snapshot — for the REST route, where a first caller can wait. */
export async function fleetSnapshot(): Promise<FleetSnapshot> {
  const age = Date.now() - snapshot.fetchedAt;
  const ttl = snapshot.source === 'crew-centre' ? FLEET_TTL_MS : ACARS_TTL_MS;
  if (age <= ttl) return snapshot;
  inFlight =
    inFlight ??
    refresh()
      .then((s) => {
        snapshot = s;
        return s;
      })
      .catch(() => snapshot)
      .finally(() => {
        inFlight = null;
      });
  return inFlight;
}

/**
 * Does this airframe belong to this unit? An exact type code first, then the
 * aircraft and subfleet names — a VA that registers everything as the base
 * Boeing type would otherwise make every 737 both a Wedgetail and a Poseidon.
 */
function unitFlies(unit: Unit, ac: { icao: string; name: string; subfleet: string | null }): boolean {
  const sub = (ac.subfleet ?? '').toLowerCase();
  const hay = `${ac.name} ${sub}`.toLowerCase();
  // RAAFv names most subfleets after the squadron ("F35A | v75SQN"). When the
  // subfleet names ANY squadron, that name decides: without this, a Growler
  // matches No. 1 Squadron because both report icao F18S.
  const named = /\bv\d+(sqn|fts|ocu)\b/.test(sub);
  if (named) return unit.sqn ? sub.includes(unit.sqn) : false;
  if (ac.icao && unit.icao.includes(ac.icao)) return true;
  return unit.keys.some((k) => hay.includes(k));
}

export type Availability = {
  /** the airframe to task, when the crew centre gave us a real one */
  aircraft: FleetAircraft | null;
  /** roles this base can actually launch right now */
  roles: Set<Role>;
  source: 'crew-centre' | 'roster';
  /** the unit the chosen aircraft belongs to */
  unit?: Unit | null;
  /** true when that unit is visiting rather than resident — a detachment */
  detachment?: boolean;
};

/**
 * How many airframes of one unit have to be sitting at a base before that base
 * can fly the unit's tasking.
 *
 * One is enough for the squadron that lives there. For anyone else it takes a
 * pair, because a single visiting aeroplane is not a capability: reading the
 * live fleet showed one No. 1 Squadron Super Hornet parked at East Sale, which
 * was enough to make the flying training base start generating QRA scrambles.
 * Two of the same unit is a detachment, and RAAFv's dry bases exist precisely to
 * have detachments put into them.
 */
const DETACHMENT_MIN = 2;

/**
 * What this base can put in the air. With live fleet data that means airframes
 * parked here and not already flying; without it, the base's resident units.
 *
 * An aircraft that is away from its hub counts at the airport it is AT — that is
 * the whole point of reading the location: if v37SQN left a Hercules at Darwin,
 * Darwin can fly a tactical airlift task and Richmond is one airframe short.
 */
export function availabilityAt(base: Base, role?: Role): Availability {
  const fleet = currentFleet();
  if (fleet.source === 'crew-centre') {
    const here = fleet.aircraft.filter(
      (a) => !a.airborne && !a.inUse && a.serviceable && (a.at ?? a.home) === base.ident,
    );

    // Group what is parked here by the unit that owns it. An airframe's roles
    // come from whichever unit in the ORBAT flies it — including a unit based
    // elsewhere, since a detachment away from home is the case worth catching.
    const byUnit = new Map<Unit, FleetAircraft[]>();
    for (const ac of here) {
      const u = unitForAircraft(ac);
      if (!u) continue; // heritage flight, GA club, instructor hacks — not tasking
      const list = byUnit.get(u);
      if (list) list.push(ac);
      else byUnit.set(u, [ac]);
    }

    const resident = new Set(base.units);
    const roles = new Set<Role>();
    const matching: { ac: FleetAircraft; unit: Unit }[] = [];
    for (const [u, list] of byUnit) {
      const isResident = resident.has(u);
      if (!isResident && list.length < DETACHMENT_MIN) continue;
      for (const r of u.roles) roles.add(r);
      if (!role || u.roles.includes(role)) for (const ac of list) matching.push({ ac, unit: u });
    }

    if (matching.length) {
      const pick = matching[Math.floor(Math.random() * matching.length)]!;
      return {
        aircraft: pick.ac,
        roles,
        source: 'crew-centre',
        unit: pick.unit,
        detachment: !resident.has(pick.unit),
      };
    }
    // Nothing suitable parked here — fall through to the ORBAT rather than
    // emptying the base, so a quiet crew centre never empties the board.
    if (roles.size) return { aircraft: null, roles, source: 'crew-centre' };
  }
  return { aircraft: null, roles: rosterRoles(base), source: 'roster' };
}

/**
 * Bases that can fly something right now — the home bases, plus any dry base
 * the live fleet shows a real detachment at. Without live data this is just the
 * home bases, which is what the published order of battle supports.
 */
export function launchableBases(): Base[] {
  const live = currentFleet().source === 'crew-centre';
  if (!live) return HOME_BASES;
  const out = [...HOME_BASES];
  for (const b of RAAFV_BASES) {
    if (!b.dry) continue;
    if (availabilityAt(b).roles.size > 0) out.push(b);
  }
  return out;
}

/** Units at this base that can fly `role` (ORBAT, not live fleet). */
export function unitsFor(base: Base, role: Role): Unit[] {
  return base.units.filter((u) => u.roles.includes(role));
}

/** Which unit in the ORBAT this airframe belongs to. */
export function unitForAircraft(ac: FleetAircraft): Unit | null {
  for (const b of RAAFV_BASES) for (const u of b.units) if (unitFlies(u, ac)) return u;
  return null;
}

/**
 * A member's own fleet, read with their key at the moment they ask. Used by the
 * desktop app so a signed-in pilot sees what THEY are cleared to fly and where
 * it is; the key is never stored here.
 */
export async function userFleet(apiKey: string): Promise<{ ok: boolean; error?: string; aircraft?: FleetAircraft[] }> {
  try {
    const res = await fetch(`${PHPVMS_URL}/api/user/fleet`, {
      headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'The crew centre did not accept that API key.' };
    if (!res.ok) return { ok: false, error: `The crew centre returned an error (${res.status}).` };
    const body = (await res.json()) as { data?: unknown[] };
    const airborne = await liveTails().catch(() => new Set<string>());
    const aircraft: FleetAircraft[] = [];
    for (const sf of body.data ?? []) {
      const s = sf as Record<string, unknown>;
      const name = str(s.name) ?? str(s.type);
      const list = Array.isArray(s.aircraft) ? s.aircraft : [sf];
      for (const item of list) {
        const ac = readAircraft(item, name);
        if (ac) {
          ac.airborne = airborne.has(ac.registration.toUpperCase());
          aircraft.push(ac);
        }
      }
    }
    return { ok: true, aircraft };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
