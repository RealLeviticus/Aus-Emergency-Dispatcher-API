import type { FastifyInstance } from 'fastify';
import { hub } from '../sync.js';

/**
 * Read-only snapshot of a session's live objects. Useful for the website, a map
 * overlay, or debugging. Mutations happen only over the WebSocket.
 */
export async function objectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { sessionId: string } }>('/api/v1/sessions/:sessionId/objects', async (req) => {
    const objects = hub.snapshot(req.params.sessionId);
    return { sessionId: req.params.sessionId, count: objects.length, objects };
  });
}
