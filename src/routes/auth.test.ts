import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';

/**
 * The crew centre is a third-party phpVMS install we do not control, so these
 * pin down what we do with the shapes it can hand back — including the ones
 * that should NOT grant access, and the ones that are not JSON at all.
 */
async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes);
  await app.ready();
  return app;
}

const KEY = 'x'.repeat(24);
const crewCentreReplies = (body: unknown, status = 200): void => {
  vi.stubGlobal('fetch', async () =>
    typeof body === 'string'
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('phpVMS sign-in', () => {
  it('rejects anything that is not key-shaped before calling out', async () => {
    const app = await build();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    for (const apiKey of ['', 'short', 'y'.repeat(200)]) {
      const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey } });
      expect(r.statusCode).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it('reads a pilot out of the phpVMS `data` envelope', async () => {
    const app = await build();
    crewCentreReplies({
      data: { id: 7, pilot_id: 42, ident: 'RAAF042', name: 'Jo Pilot', state: 1, rank: { name: 'Flight Lieutenant' } },
    });
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      ok: true,
      raafv: true,
      user: { id: '42', ident: 'RAAF042', username: 'Jo Pilot', rank: 'Flight Lieutenant' },
    });
    await app.close();
  });

  it('accepts a bare object and a string rank', async () => {
    const app = await build();
    crewCentreReplies({ id: 9, ident: 'RAAF009', name: 'Sam Crew', state: 1, rank: 'Pilot Officer' });
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.json()).toMatchObject({ ok: true, raafv: true, user: { id: '9', rank: 'Pilot Officer' } });
    await app.close();
  });

  it('withholds RAAFv from suspended and rejected accounts', async () => {
    const app = await build();
    for (const [state, word] of [
      [4, 'suspended'],
      [2, 'rejected'],
    ] as const) {
      crewCentreReplies({ data: { id: 3, name: 'Ex Member', state } });
      const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
      const body = r.json();
      expect(body.ok).toBe(true); // the key IS valid — they just don't get tasking
      expect(body.raafv).toBe(false);
      expect(body.roleReason).toContain(word);
    }
    await app.close();
  });

  it('grants when the install does not report a state at all', async () => {
    const app = await build();
    crewCentreReplies({ data: { id: 5, name: 'Old Install' } });
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.json()).toMatchObject({ ok: true, raafv: true });
    await app.close();
  });

  it('turns a bad key into 401, not a 500', async () => {
    const app = await build();
    crewCentreReplies({ error: 'nope' }, 401);
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.statusCode).toBe(401);
    expect(r.json().ok).toBe(false);
    await app.close();
  });

  it('survives a maintenance page where JSON was expected', async () => {
    const app = await build();
    crewCentreReplies('<html>maintenance</html>');
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.statusCode).toBe(502);
    await app.close();
  });

  it('reports the crew centre being unreachable as 502', async () => {
    const app = await build();
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.statusCode).toBe(502);
    await app.close();
  });

  it('never echoes the key back', async () => {
    const app = await build();
    crewCentreReplies({ data: { id: 1, name: 'Jo', state: 1 } });
    const r = await app.inject({ method: 'POST', url: '/auth/phpvms/verify', payload: { apiKey: KEY } });
    expect(r.body).not.toContain(KEY);
    await app.close();
  });
});
