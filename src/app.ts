import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { hub, type Peer } from './sync.js';
import { jobHub } from './jobs.js';
import { clientMessage, type ClientMessage, type ServerMessage } from './types.js';
import { healthRoutes } from './routes/health.js';
import { objectRoutes } from './routes/objects.js';
import { authRoutes } from './routes/auth.js';
import { fleetRoutes } from './routes/fleet.js';

function tokenOk(token: string | undefined): boolean {
  if (config.API_TOKENS.length === 0) return true; // auth disabled (dev)
  return Boolean(token && config.API_TOKENS.includes(token));
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'test' ? 'silent' : 'info' },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS.includes('*') ? true : config.ALLOWED_ORIGINS,
  });
  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(objectRoutes);
  await app.register(authRoutes);
  await app.register(fleetRoutes);

  app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket, req) => {
      let sessionId: string | null = null;
      let clientId: string | null = null;
      let lastSeen = Date.now();
      const remote = req.ip;

      const send = (msg: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const fail = (message: string) => {
        send({ type: 'error', message });
        socket.close(1008, message.slice(0, 120));
      };

      // Optional token via query string, so a client can be rejected before `hello`.
      const urlToken = new URL(req.url, 'http://localhost').searchParams.get('token') ?? undefined;
      if (config.API_TOKENS.length > 0 && !tokenOk(urlToken)) {
        // allow the token to arrive in `hello` instead; only hard-fail if it's clearly wrong
      }

      const idle = setInterval(() => {
        if (Date.now() - lastSeen > config.CLIENT_IDLE_MS) {
          fail('Idle timeout.');
        }
      }, Math.max(5_000, Math.floor(config.CLIENT_IDLE_MS / 2)));
      idle.unref?.();

      // Server-driven heartbeat: a WS `pong` (auto-sent by the client's ws lib)
      // keeps the connection alive even if the app-level `ping` stalls.
      socket.on('pong', () => {
        lastSeen = Date.now();
      });
      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.ping();
          } catch {
            /* ignore */
          }
        }
      }, 25_000);
      heartbeat.unref?.();

      // Every connection sees the global job pool and its live updates.
      let clientName = 'Operator';
      const rawSend = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const unsubJobs = jobHub.subscribe(rawSend);

      const peer: Peer = {
        get clientId() {
          return clientId ?? 'pending';
        },
        send,
      };

      socket.on('message', (raw: Buffer) => {
        lastSeen = Date.now();
        let parsed: ClientMessage;
        try {
          parsed = clientMessage.parse(JSON.parse(raw.toString()));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          app.log.warn({ session: sessionId, clientId, detail, raw: raw.toString().slice(0, 300) }, 'malformed message');
          send({ type: 'error', message: `Malformed message: ${detail.slice(0, 200)}` });
          return;
        }

        if (parsed.type === 'hello') {
          if (!tokenOk(parsed.token ?? urlToken)) return fail('Invalid token.');
          if (clientId) return; // already registered
          sessionId = parsed.sessionId;
          let joinId = parsed.clientId;
          if (hub.hasPeer(sessionId, joinId)) {
            // Two installs are presenting the same client id (a cloned config /
            // VM image). Give this connection its own id so object-ownership
            // filtering works for both — the client adopts `welcome.clientId`.
            joinId = `${joinId}#${randomUUID().slice(0, 8)}`;
            app.log.warn(
              { session: sessionId, requested: parsed.clientId, assigned: joinId, remote },
              'duplicate clientId in session — assigned a unique id',
            );
          }
          clientId = joinId;
          clientName = parsed.name || 'Operator';
          (peer as { name?: string }).name = parsed.name;
          const objects = hub.join(sessionId, {
            clientId,
            name: parsed.name,
            send,
          });
          send({ type: 'welcome', clientId, sessionId, serverTime: Date.now() });
          send({ type: 'snapshot', objects });
          // Give the joiner an immediate, accurate peer count (hub.join only
          // notifies the *other* peers).
          send({ type: 'peer.joined', clientId, count: hub.peerIds(sessionId).length });
          app.log.info(
            { session: sessionId, clientId, remote, peers: hub.peerIds(sessionId), objects: objects.length },
            'peer hello',
          );
          return;
        }

        if (parsed.type === 'ping') {
          send({ type: 'pong', serverTime: Date.now() });
          return;
        }

        if (!sessionId || !clientId) return send({ type: 'error', message: 'Send `hello` first.' });

        switch (parsed.type) {
          case 'object.create': {
            const res = hub.create(sessionId, clientId, parsed.object);
            if ('error' in res) {
              send({ type: 'error', message: res.error });
              app.log.warn({ session: sessionId, ownerId: clientId, error: res.error }, 'object.create rejected');
            } else {
              app.log.info(
                {
                  session: sessionId,
                  ownerId: clientId,
                  id: res.object.id,
                  title: res.object.title,
                  relayTo: hub.peerIds(sessionId).filter((id) => id !== clientId),
                },
                'object.create relayed',
              );
            }
            break;
          }
          case 'object.update': {
            const patch = {
              ...(parsed.lat !== undefined ? { lat: parsed.lat } : {}),
              ...(parsed.lon !== undefined ? { lon: parsed.lon } : {}),
              ...(parsed.altFt !== undefined ? { altFt: parsed.altFt } : {}),
              ...(parsed.headingDeg !== undefined ? { headingDeg: parsed.headingDeg } : {}),
              ...(parsed.onGround !== undefined ? { onGround: parsed.onGround } : {}),
            };
            const res = hub.update(sessionId, clientId, parsed.id, patch);
            if ('error' in res) send({ type: 'error', message: res.error });
            break;
          }
          case 'object.remove': {
            const res = hub.remove(sessionId, clientId, parsed.id);
            if ('error' in res) send({ type: 'error', message: res.error });
            break;
          }
          case 'object.removeMine': {
            hub.removeByOwner(sessionId, clientId);
            break;
          }
          case 'presence': {
            const { type: _t, ...p } = parsed;
            hub.presence(sessionId, clientId, p);
            break;
          }
          case 'job.locate': {
            jobHub.locate(clientId, parsed.lat, parsed.lon, parsed.channel ?? 'emergency');
            break;
          }
          case 'job.claim': {
            const r = jobHub.claim(parsed.jobId, clientId, parsed.name || clientName);
            if ('error' in r) send({ type: 'error', message: r.error });
            break;
          }
          case 'job.join': {
            const r = jobHub.join(parsed.jobId, clientId, parsed.name || clientName);
            if ('error' in r) send({ type: 'error', message: r.error });
            break;
          }
          case 'job.leave': {
            jobHub.leave(parsed.jobId, clientId);
            break;
          }
          case 'job.release': {
            jobHub.release(parsed.jobId, clientId);
            break;
          }
          case 'job.start': {
            const r = jobHub.start(parsed.jobId, clientId);
            if ('error' in r) send({ type: 'error', message: r.error });
            break;
          }
          case 'job.progress': {
            jobHub.progress(parsed.jobId, clientId, parsed.phase);
            break;
          }
          case 'job.complete': {
            jobHub.complete(parsed.jobId, clientId);
            break;
          }
        }
      });

      socket.on('close', () => {
        clearInterval(idle);
        clearInterval(heartbeat);
        unsubJobs();
        if (clientId) {
          jobHub.releaseAllClaims(clientId);
          jobHub.forget(clientId);
        }
        if (sessionId && clientId) {
          hub.leave(sessionId, clientId);
          app.log.info({ session: sessionId, clientId, remote, peers: hub.peerIds(sessionId) }, 'peer left');
        }
      });
    });
  });

  return app;
}
