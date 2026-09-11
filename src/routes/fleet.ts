import type { FastifyInstance } from 'fastify';
import { fleetSnapshot, HOME_BASES, RAAFV_BASES, rosterRoles, unitForAircraft, userFleet } from '../fleet.js';

/**
 * "Where are the RAAFv aircraft right now?"
 *
 * `GET /fleet` answers it for everyone: every airframe the crew centre knows
 * about, grouped by the airport it is currently parked at, with the ones flying
 * a live flight marked. Tasking uses the same snapshot (see fleet.ts), so what
 * an operator sees here is what the generator saw when it built the board.
 *
 * `POST /fleet/user` answers it for one member, using their own crew centre key
 * — the aircraft THEY are cleared to fly at their rank, and where those are.
 * The key is used for that one request and never stored, exactly as with
 * /auth/phpvms/verify.
 */
export async function fleetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fleet', async () => {
    const snap = await fleetSnapshot();

    const byBase: Record<
      string,
      {
        base: string;
        ident: string;
        region: string;
        dry: boolean;
        /** what the ORBAT says lives here */
        squadrons: string[];
        /** what is actually sitting here right now */
        aircraft: { registration: string; type: string; icao: string; squadron: string | null; airborne: boolean }[];
        roles: string[];
      }
    > = {};

    for (const b of RAAFV_BASES) {
      byBase[b.ident] = {
        base: b.name,
        ident: b.ident,
        region: b.region,
        dry: Boolean(b.dry),
        squadrons: b.units.map((u) => `${u.squadron} (${u.type})`),
        aircraft: [],
        roles: [...rosterRoles(b)],
      };
    }

    /** Aircraft parked somewhere that is not a RAAFv base still get listed. */
    const elsewhere: typeof byBase = {};
    for (const ac of snap.aircraft) {
      const where = (ac.at ?? ac.home ?? 'UNKNOWN').toUpperCase();
      const unit = unitForAircraft(ac);
      const row = {
        registration: ac.registration,
        type: unit?.type ?? ac.name,
        icao: ac.icao,
        squadron: unit?.squadron ?? null,
        airborne: ac.airborne,
      };
      const bucket =
        byBase[where] ??
        (elsewhere[where] = elsewhere[where] ?? {
          base: where,
          ident: where,
          region: '—',
          dry: true,
          squadrons: [],
          aircraft: [],
          roles: [],
        });
      bucket.aircraft.push(row);
    }

    const bases = [...Object.values(byBase), ...Object.values(elsewhere)].sort((a, b) =>
      b.aircraft.length - a.aircraft.length || a.ident.localeCompare(b.ident),
    );

    return {
      source: snap.source,
      fetchedAt: snap.fetchedAt,
      note: snap.note,
      total: snap.aircraft.length,
      airborne: snap.airborne,
      homeBases: HOME_BASES.map((b) => b.ident),
      bases,
    };
  });

  app.post('/fleet/user', async (req, reply) => {
    const body = (req.body ?? {}) as { apiKey?: string };
    const key = String(body.apiKey ?? '').trim();
    if (!key || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ ok: false, error: 'That does not look like an API key.' });
    }
    const res = await userFleet(key);
    if (!res.ok) return reply.code(res.error?.includes('did not accept') ? 401 : 502).send(res);
    return {
      ok: true,
      aircraft: (res.aircraft ?? []).map((ac) => {
        const unit = unitForAircraft(ac);
        return {
          registration: ac.registration,
          type: unit?.type ?? ac.name,
          icao: ac.icao,
          squadron: unit?.squadron ?? null,
          at: ac.at ?? ac.home ?? null,
          home: ac.home ?? null,
          airborne: ac.airborne,
        };
      }),
    };
  });
}
