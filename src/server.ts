import { buildApp } from './app.js';
import { config } from './config.js';
import { fleetSnapshot } from './fleet.js';
import { jobHub } from './jobs.js';

const app = await buildApp();

/**
 * Warm the RAAFv fleet BEFORE seeding the board.
 *
 * `currentFleet()` is deliberately non-blocking — it hands back whatever is
 * cached and refreshes behind you — so the very first jobs generated after a
 * restart were built against an empty cache and fell back to the published
 * order of battle. They are then stuck that way for their whole 14-minute life,
 * so every restart produced a full board with no tail numbers on it even though
 * the crew centre was reachable the whole time.
 *
 * One await fixes it. It is bounded by the fetch's own timeout and failure is
 * ignored, so an unreachable crew centre still starts the server on time.
 */
await fleetSnapshot().catch(() => undefined);

// Fill and keep topping up the shared tasking pool.
jobHub.seed();
const jobTimer = setInterval(() => jobHub.tick(), 20_000);
jobTimer.unref?.();

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`dispatcher-api listening on ${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
  });
}
