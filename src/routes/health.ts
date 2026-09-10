import type { FastifyInstance } from 'fastify';
import { hub } from '../sync.js';
import { jobHub } from '../jobs.js';

/** Matches the OzServer `/health` contract: process check now, room + DB checks as they land. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'dispatcher-api',
    uptimeSeconds: Math.round(process.uptime()),
    ...hub.stats(),
    tasking: jobHub.stats(),
  }));
}
