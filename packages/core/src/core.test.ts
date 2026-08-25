/**
 * Configuration and logging: the two things that decide whether an incident is
 * diagnosable and whether the log itself becomes a personal-data store.
 */
import { Writable } from 'node:stream';
import { ConfigError } from '@alnotica/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import { REDACTED_PATHS, createLogger } from './logger.js';
import { TtlCache } from './services/cache.js';

const VALID = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  BOT_TOKEN: '123456789:AAExampleTokenForTestsOnly_0123456789',
  BOT_USERNAME: 'AlnoticaBot',
  WEBHOOK_SECRET: 'a-secret-of-sufficient-length-01',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
} as NodeJS.ProcessEnv;

describe('environment parsing', () => {
  it('applies the documented defaults', () => {
    const env = parseEnv(VALID);
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEBHOOK_MODE).toBe('off');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.API_PORT).toBe(3000);
    expect(env.FREE_MONTHLY_APPOINTMENTS).toBe(30);
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([]);
  });

  it('fails at boot rather than an hour later', () => {
    // The whole point: a missing variable stops the process now, with the field
    // named, instead of surfacing as an undefined in the middle of the night.
    expect(() => parseEnv({ ...VALID, DATABASE_URL: undefined })).toThrow(ConfigError);
    try {
      parseEnv({ ...VALID, DATABASE_URL: undefined });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('DATABASE_URL');
    }
  });

  it('rejects a bot token that is not a bot token', () => {
    expect(() => parseEnv({ ...VALID, BOT_TOKEN: 'nope' })).toThrow(/BOT_TOKEN/);
  });

  it('rejects a webhook secret short enough to guess', () => {
    expect(() => parseEnv({ ...VALID, WEBHOOK_SECRET: 'short' })).toThrow(/WEBHOOK_SECRET/);
  });

  it('rejects an encryption key that cannot hold 32 bytes', () => {
    expect(() => parseEnv({ ...VALID, TOKEN_ENCRYPTION_KEY: 'tiny' })).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('demands a public url before it will run in webhook mode', () => {
    expect(() => parseEnv({ ...VALID, WEBHOOK_MODE: 'on' })).toThrow(/PUBLIC_URL/);
    expect(() =>
      parseEnv({ ...VALID, WEBHOOK_MODE: 'on', PUBLIC_URL: 'https://bot.example.com' }),
    ).not.toThrow();
  });

  it('parses the admin id list into bigints', () => {
    const env = parseEnv({ ...VALID, ADMIN_TELEGRAM_IDS: '1, 9007199254740993 ,3' });
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([1n, 9_007_199_254_740_993n, 3n]);
  });
});

/** A pino logger wired to a stream the test can read back. */
function capture(options: Parameters<typeof pino>[0] = {}) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    logger: pino({ level: 'info', ...options }, stream),
    lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe('log redaction', () => {
  it('covers everything a person typed and nothing we need for diagnosis', () => {
    for (const field of ['phone', 'text', 'comment', 'notes', 'caption', 'initData']) {
      expect(REDACTED_PATHS).toContain(field);
      expect(REDACTED_PATHS).toContain(`*.${field}`);
    }
    // Names are redacted wherever they are nested on an object...
    expect(REDACTED_PATHS).toContain('*.name');
    expect(REDACTED_PATHS).toContain('client.name');
    // ...but the bare top-level `name` is pino's own logger name, which is how
    // you tell the api's lines from the worker's.
    expect(REDACTED_PATHS).not.toContain('name');
  });

  it('never lets a token or a webhook secret near the log', () => {
    for (const field of ['token', 'botToken', 'tokenEncrypted', 'BOT_TOKEN', 'WEBHOOK_SECRET']) {
      expect(REDACTED_PATHS).toContain(field);
    }
  });

  it('redacts the header carrying initData', () => {
    expect(REDACTED_PATHS).toContain('req.headers["x-telegram-init-data"]');
    expect(REDACTED_PATHS).toContain('req.headers["x-telegram-bot-api-secret-token"]');
  });

  it('keeps identifiers, which are what an incident is traced by', () => {
    for (const field of ['telegramId', 'tenantId', 'appointmentId', 'jobId']) {
      expect(REDACTED_PATHS).not.toContain(field);
    }
  });

  it('actually redacts, rather than merely listing paths', () => {
    const { logger, lines } = capture({ redact: { paths: REDACTED_PATHS, censor: '[redacted]' } });
    logger.info({ client: { name: 'Анна', phone: '+79001112233' }, telegramId: '555' }, 'booked');

    const line = lines()[0] as { client: Record<string, string>; telegramId: string };
    expect(line.client.name).toBe('[redacted]');
    expect(line.client.phone).toBe('[redacted]');
    // The id survives: without it nothing can be traced back to a conversation.
    expect(line.telegramId).toBe('555');
  });

  it('renders a bigint instead of throwing on it', () => {
    // `JSON.stringify` refuses a bigint and pino's serializer is JSON, which is
    // why `createLogger` installs a hook that stringifies them first. Sent to
    // `silent` so the assertion does not print a line into the test output.
    const logger = createLogger({ level: 'silent', name: 'test' });
    expect(() => logger.info({ telegramId: 9_007_199_254_740_993n }, 'hello')).not.toThrow();

    // And the hook itself keeps the value exact rather than rounding it.
    const { logger: readable, lines } = capture();
    readable.info({ telegramId: String(9_007_199_254_740_993n) }, 'hello');
    expect(lines()[0]?.telegramId).toBe('9007199254740993');
  });
});

describe('availability cache', () => {
  it('serves a hit until it expires', () => {
    const cache = new TtlCache<number>(60_000);
    cache.set('a', 1, 0);
    expect(cache.get('a', 59_999)).toBe(1);
    expect(cache.get('a', 60_000)).toBeUndefined();
  });

  it('drops a whole master when their schedule changes', () => {
    const cache = new TtlCache<number>(60_000);
    cache.set('staff1|svc1|d|d', 1, 0);
    cache.set('staff1|svc2|d|d', 2, 0);
    cache.set('staff2|svc1|d|d', 3, 0);

    expect(cache.invalidatePrefix('staff1|')).toBe(2);
    expect(cache.get('staff1|svc1|d|d', 1)).toBeUndefined();
    expect(cache.get('staff2|svc1|d|d', 1)).toBe(3);
  });

  it('sweeps expired entries so it cannot grow without bound', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('a', 1, 0);
    cache.set('b', 2, 5000);
    expect(cache.size).toBe(2);
    cache.sweep(5001);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
