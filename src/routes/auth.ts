import type { FastifyInstance } from 'fastify';

/**
 * RAAFv access, by either of two routes.
 *
 * 1. phpVMS — the crew centre at crew.raafvirtual.org runs phpVMS v7, which
 *    gives every pilot their own API key at registration. The member pastes
 *    that key once and we ask the crew centre who it belongs to. This proves
 *    membership of the actual pilot roster and needs nothing from RAAFv staff:
 *    the API is enabled by default and the key is on the member's own profile.
 *
 * 2. Discord OAuth — the desktop app opens the consent screen, catches the
 *    `code` on a loopback redirect, and POSTs it here; this route holds the
 *    client secret, exchanges the code and checks the RAAFv role. Note this
 *    needs no bot in the guild either: `guilds.members.read` is granted by the
 *    user, against their own token.
 *
 * Env (all optional — when unset, that route is simply "not configured"):
 *   PHPVMS_URL (default https://crew.raafvirtual.org), PHPVMS_NAME
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
 *   RAAFV_GUILD_ID, RAAFV_ROLE_ID (comma-separated role ids allowed)
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---- phpVMS crew centre ---------------------------------------------
  const PHPVMS_URL = (process.env.PHPVMS_URL ?? 'https://crew.raafvirtual.org').replace(/\/+$/, '');
  const PHPVMS_NAME = process.env.PHPVMS_NAME ?? 'RAAF Virtual';

  /**
   * phpVMS UserState. A key belonging to a rejected or suspended account must
   * not open RAAFv tasking; pending and on-leave pilots are still members.
   * Anything we don't recognise is allowed — a valid key means a real account,
   * and we would rather not lock out a member over an enum we misread.
   */
  const DENIED_STATES: Record<number, string> = { 2: 'rejected', 4: 'suspended' };

  app.get('/auth/phpvms/config', async () => ({
    configured: true,
    name: PHPVMS_NAME,
    url: PHPVMS_URL,
    /** where the member finds their key */
    profileUrl: `${PHPVMS_URL}/profile`,
  }));

  app.post('/auth/phpvms/verify', async (req, reply) => {
    const body = (req.body ?? {}) as { apiKey?: string };
    const key = String(body.apiKey ?? '').trim();
    // Bound the length before spending an outbound request on it. Never log it.
    if (!key || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ ok: false, error: 'That does not look like an API key.' });
    }

    let res: Response;
    try {
      res = await fetch(`${PHPVMS_URL}/api/user`, {
        headers: { 'X-API-KEY': key, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'phpvms verify: crew centre unreachable');
      return reply.code(502).send({ ok: false, error: `Could not reach the ${PHPVMS_NAME} crew centre.` });
    }

    if (res.status === 401 || res.status === 403) {
      return reply.code(401).send({ ok: false, error: 'The crew centre did not accept that API key.' });
    }
    if (!res.ok) {
      app.log.warn({ status: res.status }, 'phpvms verify: unexpected status');
      return reply.code(502).send({ ok: false, error: `The crew centre returned an error (${res.status}).` });
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return reply.code(502).send({ ok: false, error: 'The crew centre sent a response we could not read.' });
    }
    // phpVMS wraps the resource in `data`, but be tolerant of a bare object.
    const u = ((payload as { data?: unknown })?.data ?? payload) as {
      id?: number | string;
      pilot_id?: number | string;
      ident?: string;
      name?: string;
      avatar?: string | null;
      state?: number;
      rank?: { name?: string } | string | null;
    };
    if (!u || typeof u !== 'object') {
      return reply.code(502).send({ ok: false, error: 'The crew centre sent an unexpected profile.' });
    }

    const denied = typeof u.state === 'number' ? DENIED_STATES[u.state] : undefined;
    const rank = typeof u.rank === 'string' ? u.rank : (u.rank?.name ?? null);

    return {
      ok: true,
      raafv: !denied,
      roleReason: denied ? `crew centre account is ${denied}` : 'verified against the crew centre',
      user: {
        id: String(u.pilot_id ?? u.id ?? ''),
        ident: u.ident ?? null,
        username: u.name ?? u.ident ?? 'RAAFv pilot',
        rank,
        avatar: typeof u.avatar === 'string' && u.avatar ? u.avatar : null,
      },
    };
  });

  // ---- Discord --------------------------------------------------------
  const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
  const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? '';
  const GUILD_ID = process.env.RAAFV_GUILD_ID ?? '';
  const ROLE_IDS = (process.env.RAAFV_ROLE_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const configured = Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

  app.get('/auth/discord/config', async () => ({
    configured,
    clientId: configured ? CLIENT_ID : '',
    redirectUri: configured ? REDIRECT_URI : '',
    scope: 'identify guilds guilds.members.read',
    guildGated: Boolean(GUILD_ID),
  }));

  app.post('/auth/discord/exchange', async (req, reply) => {
    if (!configured) return reply.code(503).send({ ok: false, error: 'Discord OAuth is not configured on the server.' });
    const body = (req.body ?? {}) as { code?: string; redirectUri?: string };
    if (!body.code) return reply.code(400).send({ ok: false, error: 'Missing code.' });

    // 1. code -> tokens
    const tokRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirectUri || REDIRECT_URI,
      }),
    });
    if (!tokRes.ok) {
      const t = await tokRes.text();
      app.log.warn({ status: tokRes.status, t: t.slice(0, 200) }, 'discord token exchange failed');
      return reply.code(400).send({ ok: false, error: 'Discord rejected the sign-in.' });
    }
    const tok = (await tokRes.json()) as { access_token: string; token_type: string };
    const auth = { authorization: `${tok.token_type} ${tok.access_token}` };

    // 2. who is it
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: auth });
    if (!meRes.ok) return reply.code(400).send({ ok: false, error: 'Could not read the Discord profile.' });
    const me = (await meRes.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
    };

    // 3. RAAFv role check
    let raafv = false;
    let roleReason = 'no guild configured';
    if (GUILD_ID) {
      const memRes = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, { headers: auth });
      if (memRes.ok) {
        const mem = (await memRes.json()) as { roles?: string[] };
        const roles = mem.roles ?? [];
        raafv = ROLE_IDS.length === 0 ? true : ROLE_IDS.some((r) => roles.includes(r));
        roleReason = raafv ? 'role present' : 'in guild, missing role';
      } else if (memRes.status === 404) {
        roleReason = 'not a member of the RAAFv guild';
      } else {
        roleReason = `guild check failed (${memRes.status})`;
      }
    }

    return {
      ok: true,
      raafv,
      roleReason,
      user: {
        id: me.id,
        username: me.global_name || me.username,
        avatar: me.avatar
          ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
          : null,
      },
    };
  });
}
