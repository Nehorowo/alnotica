import { ConfigError } from '@alnotica/shared';
/**
 * Environment configuration.
 *
 * Parsed once at boot with Zod. A missing or malformed variable takes the process
 * down immediately with a readable message, instead of surfacing as an undefined
 * at three in the morning.
 */
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', 'off'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'on');

const port = z.coerce.number().int().min(1).max(65_535);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  /** Ten per process; two processes stay comfortably under max_connections=100. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Token of the shared bot every tenant starts on. */
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'not a Telegram bot token'),
  BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{4,32}$/),

  /**
   * Sent to Telegram with setWebhook and echoed back in
   * X-Telegram-Bot-Api-Secret-Token. Without it anyone can post fake updates.
   */
  WEBHOOK_SECRET: z.string().min(16).max(256),
  WEBHOOK_MODE: z.enum(['on', 'off']).default('off'),
  PUBLIC_URL: z.string().url().optional(),

  /** 32 bytes, base64 or hex. Encrypts dedicated bots' tokens at rest. */
  TOKEN_ENCRYPTION_KEY: z.string().min(32),

  API_PORT: port.default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  MINIAPP_DIST: z.string().default('apps/miniapp/dist'),

  WORKER_ID: z.string().default(''),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),

  POLICY_URL: z.string().url().default('https://example.com/policy'),
  OFFER_URL: z.string().url().default('https://example.com/offer'),
  SUPPORT_USERNAME: z.string().default('alnotica_support'),

  /** Telegram chat that receives sales leads, moderation queue and alerts. */
  ADMIN_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => BigInt(x)),
    ),

  ALERT_TG_TOKEN: z.string().optional(),
  ALERT_TG_CHAT: z.string().optional(),
  ALERTS_ENABLED: bool.default(false),

  /** Free-tier ceiling; overridable so a test can reach it without 30 bookings. */
  FREE_MONTHLY_APPOINTMENTS: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`invalid environment:\n${details}`);
  }
  const env = parsed.data;
  if (env.WEBHOOK_MODE === 'on' && !env.PUBLIC_URL) {
    throw new ConfigError('PUBLIC_URL is required when WEBHOOK_MODE=on');
  }
  return env;
}

let cached: Env | null = null;

/** Parses once per process; every module sees the same validated object. */
export function env(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test helper: forget the cached parse. */
export function resetEnvCache(): void {
  cached = null;
}
