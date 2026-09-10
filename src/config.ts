import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),

  /**
   * Shared secret every client must present (WebSocket query `?token=` or the
   * first `hello` message). Comma-separate to allow more than one. Leave unset
   * in development to disable the check.
   */
  API_TOKENS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),

  /** Allowed browser/app origins for CORS + the REST snapshot routes. */
  ALLOWED_ORIGINS: z
    .string()
    .default('*')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  /** How long an owner's objects survive after they disconnect (ms). */
  OWNER_GRACE_MS: z.coerce.number().int().nonnegative().default(60_000),

  /** Drop a client that has not sent anything (incl. ping/pong) for this long (ms). */
  CLIENT_IDLE_MS: z.coerce.number().int().positive().default(100_000),

  /** Hard cap on live objects per session, to bound memory. */
  MAX_OBJECTS_PER_SESSION: z.coerce.number().int().positive().default(500),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProd = config.NODE_ENV === 'production';
