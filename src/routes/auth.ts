import type { FastifyInstance } from 'fastify';

/**
 * Discord OAuth for RAAFv access. The desktop app opens the Discord consent
 * screen, catches the `code` on a loopback redirect, and POSTs it here. This
 * route holds the client secret, exchanges the code, and checks whether the
 * user holds the RAAFv role in the RAAFv guild.
 *
 * Env (all optional — when unset, RAAFv linking is simply "not configured"):
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
 *   RAAFV_GUILD_ID, RAAFV_ROLE_ID (comma-separated role ids allowed)
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
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
