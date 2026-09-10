import { buildApp } from './app.js';
import { config } from './config.js';
import { jobHub } from './jobs.js';

const app = await buildApp();

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
