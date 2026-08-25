/**
 * Structured logging. JSON to stdout, nothing else — the container runtime owns
 * collection and rotation.
 *
 * What we never log: bot tokens, message bodies, phone numbers, client names.
 * What we do log: `telegramId`, tenant and appointment ids, error codes. That is
 * enough to follow a request without turning the log into a personal-data store.
 */
import { type Logger, pino, stdSerializers } from 'pino';

export const REDACTED_PATHS = [
  'token',
  '*.token',
  'botToken',
  '*.botToken',
  'tokenEncrypted',
  '*.tokenEncrypted',
  'TOKEN_ENCRYPTION_KEY',
  'BOT_TOKEN',
  'WEBHOOK_SECRET',
  'phone',
  '*.phone',
  'name',
  '*.name',
  'text',
  '*.text',
  'caption',
  '*.caption',
  'comment',
  '*.comment',
  'notes',
  '*.notes',
  'initData',
  '*.initData',
  'req.headers["x-telegram-init-data"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers.authorization',
];

export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  return pino({
    level: options.level ?? 'info',
    name: options.name ?? 'alnotica',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // bigint would otherwise throw inside the serializer.
    serializers: {
      err: stdSerializers.err,
    },
    hooks: {
      logMethod(args, method) {
        // `sanitizeBigints` maps the tuple element-wise, which TypeScript models
        // as `unknown[]`; the arity and order are preserved.
        method.apply(this, sanitizeBigints(args) as Parameters<typeof method>);
      },
    },
  });
}

/** Pino's JSON serializer throws on bigint; ours renders it as a decimal string. */
function sanitizeBigints(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'bigint') return arg.toString();
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(arg)) {
        out[k] = typeof v === 'bigint' ? v.toString() : v;
      }
      return out;
    }
    return arg;
  });
}

export type { Logger };
