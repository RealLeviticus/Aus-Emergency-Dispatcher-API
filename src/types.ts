import { z } from 'zod';

/** A simulator object one client has injected and wants every peer to mirror. */
export const simObjectInput = z.object({
  /** Client-side temp id, echoed back on `object.created` so the client can map it. */
  tempId: z.string().min(1).max(64),
  kind: z.enum(['vehicle', 'aircraft', 'boat', 'effect', 'static', 'test', 'other']).default('other'),
  /** SimConnect container title, e.g. "Container_Barrel", "raaf_lpallet". */
  title: z.string().min(1).max(128),
  /** ordered fallback titles for peers that do not have `title` installed */
  fallbacks: z.array(z.string().min(1).max(128)).max(8).optional(),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  altFt: z.number().default(0),
  headingDeg: z.number().default(0),
  onGround: z.boolean().default(true),
  /** Free-form: job id, colour, label — carried through untouched. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type SimObjectInput = z.infer<typeof simObjectInput>;

export type SimObject = {
  id: string;
  ownerId: string;
  kind: SimObjectInput['kind'];
  title: string;
  fallbacks?: string[];
  lat: number;
  lon: number;
  altFt: number;
  headingDeg: number;
  onGround: boolean;
  meta?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export const presenceInput = z.object({
  lat: z.number(),
  lon: z.number(),
  altFt: z.number(),
  headingDeg: z.number(),
  groundSpeedKt: z.number(),
  onGround: z.boolean(),
  callsign: z.string().max(32),
  aircraft: z.string().max(64),
  phase: z.string().max(24),
});
export type PresenceInput = z.infer<typeof presenceInput>;

// ---- Wire protocol ---------------------------------------------------------

export const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    sessionId: z.string().min(1).max(64),
    clientId: z.string().min(1).max(64),
    name: z.string().max(64).optional(),
    token: z.string().max(256).optional(),
  }),
  z.object({ type: z.literal('object.create'), object: simObjectInput }),
  z.object({
    type: z.literal('object.update'),
    id: z.string().min(1),
    lat: z.number().gte(-90).lte(90).optional(),
    lon: z.number().gte(-180).lte(180).optional(),
    altFt: z.number().optional(),
    headingDeg: z.number().optional(),
    onGround: z.boolean().optional(),
  }),
  z.object({ type: z.literal('object.remove'), id: z.string().min(1) }),
  z.object({ type: z.literal('object.removeMine') }),
  z.object({ type: z.literal('presence'), ...presenceInput.shape }),
  z.object({ type: z.literal('ping') }),
  // --- shared job pool ---
  z.object({
    type: z.literal('job.locate'),
    lat: z.number(),
    lon: z.number(),
    channel: z.enum(['emergency', 'raafv']).optional(),
  }),
  z.object({ type: z.literal('job.claim'), jobId: z.string().min(1), name: z.string().max(48).optional() }),
  z.object({ type: z.literal('job.join'), jobId: z.string().min(1), name: z.string().max(48).optional() }),
  z.object({ type: z.literal('job.leave'), jobId: z.string().min(1) }),
  z.object({ type: z.literal('job.release'), jobId: z.string().min(1) }),
  z.object({ type: z.literal('job.start'), jobId: z.string().min(1) }),
  z.object({
    type: z.literal('job.progress'),
    jobId: z.string().min(1),
    phase: z.enum(['enroute', 'onscene', 'transport', 'athospital', 'returning']),
  }),
  z.object({ type: z.literal('job.complete'), jobId: z.string().min(1) }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export type ServerMessage =
  | { type: 'welcome'; clientId: string; sessionId: string; serverTime: number }
  | { type: 'snapshot'; objects: SimObject[] }
  | { type: 'object.created'; tempId: string; object: SimObject }
  | { type: 'object.updated'; object: SimObject }
  | { type: 'object.removed'; id: string }
  | ({ type: 'peer.presence'; clientId: string; at: number } & PresenceInput)
  | { type: 'peer.joined'; clientId: string; name?: string; count: number }
  | { type: 'peer.left'; clientId: string; count: number }
  | { type: 'pong'; serverTime: number }
  | { type: 'error'; message: string };
