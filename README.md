# dispatcher-api

Realtime sync service for **Aus Emergency Dispatcher**. Its job for this milestone: when
one app user injects an object into their simulator, every other user in the same session
sees it and mirrors it into their own sim (the "multi-person response" feature, and the
gap left by the single-user standalone tool — see `../RPWG-ATR/DECOMPILE-NOTES.md`).

## Stack

Fastify + TypeScript on Node 22, `@fastify/websocket`, `zod`. In-memory authoritative
object store (objects are ephemeral, cleared on disconnect); Postgres is a later add for
persistent GM-placed targets only. Deploys behind Caddy on the OzServer VPS as an
isolated Docker Compose stack — see [deploy/README.md](deploy/README.md).

## Local run

```bash
npm install
cp .env.example .env
npm run dev            # ws://localhost:3100/ws , GET /health
npm test
```

## Protocol

Connect a WebSocket to `/ws` (optionally `?token=<secret>` when `API_TOKENS` is set), then:

| Client → server | |
| --- | --- |
| `{type:"hello", sessionId, clientId, name?, token?}` | join a session; server replies `welcome` + `snapshot` |
| `{type:"object.create", object:{tempId, kind, title, lat, lon, altFt, headingDeg, onGround, meta?}}` | inject; server replies `object.created` to everyone |
| `{type:"object.update", id, lat?, lon?, altFt?, headingDeg?, onGround?}` | move (owner only) |
| `{type:"object.remove", id}` / `{type:"object.removeMine"}` | delete (owner only) |
| `{type:"ping"}` | keepalive; server replies `pong` |

| Server → client | |
| --- | --- |
| `welcome`, `snapshot`, `object.created`, `object.updated`, `object.removed` | |
| `peer.joined`, `peer.left`, `pong`, `error` | |

Ownership is by `clientId` (a stable per-install id the app chooses). Update/remove are
owner-only. If an owner disconnects, their objects are purged after `OWNER_GRACE_MS`
unless the same `clientId` reconnects first.

Read-only REST: `GET /api/v1/sessions/:sessionId/objects` (snapshot, for a map overlay or
the website), `GET /health`.

## Next

- Electron client: a `SyncClient` in the app's main process that bridges `SimBridge`
  (`../Desktop App/main/simconnect.ts`) ⇄ this server — publish local injections, and re-inject peers'
  objects via `aICreateSimulatedObject`, tracking a `serverId → local sim object id` map.
- Real auth (VATSIM CID / RAAFv entitlement) replacing the shared token.
- Postgres for persistent targets.
