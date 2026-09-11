import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The live-fleet path, against a stub crew centre.
 *
 * We cannot point the suite at crew.raafvirtual.org — reading the real fleet
 * needs a member's API key and would make the tests depend on someone else's
 * uptime — so this serves the shapes phpVMS v7 actually returns.
 *
 * The fixtures below are copied from a real read of RAAFv's fleet, including the
 * parts that broke naive matching: v1SQN's Super Hornets and v6SQN's Growlers
 * BOTH report icao `F18S` and are told apart only by the subfleet name, the E-7A
 * reports `E737` rather than `E7`, the BBJ is a `B38M`, and `meta.next_page` is
 * a URL rather than a page number.
 */

type Fleet = typeof import('./fleet.js');

let server: Server;
let fleet: Fleet;
let PHPVMS = '';

/** Exactly the shape phpVMS v7 returns, trimmed to the fields we read. */
const ac = (o: Record<string, unknown>) => ({ status: 'A', state: 0, ...o });

const SUBFLEETS = [
  {
    id: 1,
    name: 'F35A | v3SQN',
    type: 'F35A-v3SQN',
    aircraft: [
      // parked at its home base
      ac({ id: 1, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-001', airport_id: 'YWLM', hub_id: 'YWLM' }),
      // deployed north as a PAIR — this is the case the whole feature exists for
      ac({ id: 2, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-002', airport_id: 'YPDN', hub_id: 'YWLM' }),
      ac({ id: 10, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-005', airport_id: 'YPDN', hub_id: 'YWLM' }),
      // a single jet passing through East Sale is NOT a capability
      ac({ id: 11, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-006', airport_id: 'YMES', hub_id: 'YWLM' }),
      // in the air on someone's flight right now
      ac({ id: 3, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-003', airport_id: 'YWLM', hub_id: 'YWLM' }),
      // in the hangar — phpVMS says so, and ACARS never would
      ac({ id: 7, icao: 'F35A', name: 'F-35A Lightning II', registration: 'A35-004', airport_id: 'YWLM', hub_id: 'YWLM', status: 'M' }),
    ],
  },
  {
    id: 2,
    name: 'C130J Hercules',
    type: 'C130',
    aircraft: [ac({ id: 4, icao: 'C130', name: 'C-130J Hercules', registration: 'A97-440', airport_id: 'YSRI', hub_id: 'YSRI' })],
  },
  {
    id: 3,
    name: 'E7A Wedgetail',
    type: 'E737',
    aircraft: [ac({ id: 5, icao: 'E737', name: 'E-7A Wedgetail "Copper"', registration: 'A30-001', airport_id: 'YWLM', hub_id: 'YWLM' })],
  },
  {
    id: 4,
    name: 'P8A Poseidon',
    type: 'P8',
    aircraft: [ac({ id: 6, icao: 'P8', name: 'P-8A Poseidon', registration: 'A47-001', airport_id: 'YPED', hub_id: 'YPED' })],
  },
  // The pair that defeats type matching: same icao, different squadron and
  // different aeroplane. Only the subfleet name separates them.
  {
    id: 5,
    name: 'F18F | v1SQN',
    type: 'F18F-v1SQN',
    aircraft: [ac({ id: 8, icao: 'F18S', name: 'F/A-18F Rhino', registration: 'A44-212', airport_id: 'YAMB', hub_id: 'YAMB' })],
  },
  {
    id: 6,
    name: 'F18G | v6SQN',
    type: 'F18G-v6SQN',
    aircraft: [ac({ id: 9, icao: 'F18S', name: 'E/A-18G Growler', registration: 'A46-312', airport_id: 'YAMB', hub_id: 'YAMB' })],
  },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/acars') {
      res.end(JSON.stringify({ data: [{ id: 'f1', aircraft: { registration: 'A35-003' } }] }));
      return;
    }
    if (url.pathname === '/api/fleet') {
      if (req.headers['x-api-key'] !== 'test-key') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'Invalid or missing API key' } }));
        return;
      }
      // phpVMS returns next_page as a URL, not a page number
      const page = Number(url.searchParams.get('page') ?? 1);
      const first = page === 1;
      res.end(
        JSON.stringify({
          data: first ? SUBFLEETS : [],
          meta: { next_page: first ? `${PHPVMS}/api/fleet?page=2` : null },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  PHPVMS = `http://127.0.0.1:${port}`;

  // fleet.ts reads its configuration at import time, so set it first.
  process.env.PHPVMS_URL = PHPVMS;
  process.env.PHPVMS_API_KEY = 'test-key';
  fleet = await import('./fleet.js');
});

afterAll(() => {
  server.close();
});

describe('crew centre fleet', () => {
  it('reads every airframe and where it is', async () => {
    const snap = await fleet.fleetSnapshot();
    expect(snap.source).toBe('crew-centre');
    expect(snap.aircraft).toHaveLength(11);
    const byReg = new Map(snap.aircraft.map((a) => [a.registration, a]));
    expect(byReg.get('A35-001')!.at).toBe('YWLM');
    expect(byReg.get('A35-002')!.at).toBe('YPDN');
    expect(byReg.get('A35-002')!.home).toBe('YWLM');
  });

  it('marks the aircraft that is flying right now', async () => {
    const snap = await fleet.fleetSnapshot();
    expect(snap.airborne).toBe(1);
    expect(snap.aircraft.find((a) => a.registration === 'A35-003')!.airborne).toBe(true);
  });

  it('tells the Super Hornet and the Growler apart despite both being F18S', async () => {
    const snap = await fleet.fleetSnapshot();
    const of = (reg: string) => fleet.unitForAircraft(snap.aircraft.find((a) => a.registration === reg)!);
    expect(of('A44-212')?.squadron).toBe('No. 1 Squadron');
    expect(of('A44-212')?.type).toBe('F/A-18F Super Hornet');
    expect(of('A46-312')?.squadron).toBe('No. 6 Squadron');
    expect(of('A46-312')?.type).toBe('EA-18G Growler');
  });

  it('reads the type designators the crew centre really publishes', async () => {
    const snap = await fleet.fleetSnapshot();
    const of = (reg: string) => fleet.unitForAircraft(snap.aircraft.find((a) => a.registration === reg)!);
    // E737, not E7 — and the Hercules is C130, not C30J
    expect(of('A30-001')?.squadron).toBe('No. 2 Squadron');
    expect(of('A97-440')?.squadron).toBe('No. 37 Squadron');
    expect(of('A47-001')?.squadron).toBe('No. 11 Squadron');
  });

  it('does not offer an aircraft that is in maintenance', async () => {
    const snap = await fleet.fleetSnapshot();
    expect(snap.aircraft.find((a) => a.registration === 'A35-004')!.serviceable).toBe(false);
  });

  it('offers a real tail number for a base that has one parked', async () => {
    await fleet.fleetSnapshot();
    const wlm = fleet.HOME_BASES.find((b) => b.ident === 'YWLM')!;
    const avail = fleet.availabilityAt(wlm, 'qra');
    expect(avail.source).toBe('crew-centre');
    // A35-003 is airborne, A35-002 is at Darwin and A35-004 is in maintenance,
    // so only A35-001 can be tasked.
    expect(avail.aircraft?.registration).toBe('A35-001');
  });

  it('stands a dry base up when a detachment is genuinely parked there', async () => {
    await fleet.fleetSnapshot();
    const darwin = fleet.RAAFV_BASES.find((b) => b.ident === 'YPDN')!;
    const avail = fleet.availabilityAt(darwin, 'qra');
    expect(['A35-002', 'A35-005']).toContain(avail.aircraft?.registration);
    expect(avail.roles.has('qra')).toBe(true);
    expect(avail.detachment).toBe(true);
    expect(fleet.launchableBases().map((b) => b.ident)).toContain('YPDN');
  });

  it('does not turn one visiting jet into a capability', async () => {
    // A lone No. 3 Squadron F-35 parked at the flying training base must not
    // make East Sale start generating QRA scrambles.
    await fleet.fleetSnapshot();
    const sale = fleet.HOME_BASES.find((b) => b.ident === 'YMES')!;
    expect(fleet.availabilityAt(sale).roles.has('qra')).toBe(false);
    expect(fleet.launchableBases().map((b) => b.ident)).not.toContain('YBTL');
  });

  it('does not invent capability at a base with nothing parked', async () => {
    await fleet.fleetSnapshot();
    const curtin = fleet.RAAFV_BASES.find((b) => b.ident === 'YCIN')!;
    const avail = fleet.availabilityAt(curtin, 'qra');
    expect(avail.aircraft).toBeNull();
    expect(avail.roles.size).toBe(0);
  });
});
