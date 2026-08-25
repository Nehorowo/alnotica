/**
 * Test harness: a real Postgres, a real Fastify instance, a real grammY client
 * pointed at a mock Bot API. Nothing between the test and the production code
 * paths except the transport.
 */
import { randomUUID } from 'node:crypto';
import {
  BotRegistry,
  type Env,
  type Queue,
  createLogger,
  createQueue,
  generateBotHash,
  parseEnv,
} from '@alnotica/core';
import {
  type BotRow,
  type ClientRow,
  type ServiceRow,
  type StaffRow,
  type TenantRow,
  botRepo,
  forTenant,
  jobRepo,
  tenantRepo,
} from '@alnotica/db';
import { type AppContext, createContext } from '../../apps/api/src/lib/context.js';
import { type App, createServer } from '../../apps/api/src/lib/server.js';
import { registerHealthRoutes } from '../../apps/api/src/routes/health.js';
import { registerMiniAppRoutes } from '../../apps/api/src/routes/miniapp.js';
import { registerWebhookRoutes } from '../../apps/api/src/routes/webhook.js';
import { wireBot } from '../../apps/worker/src/bot/index.js';
import { type JobContext, createJobContext } from '../../apps/worker/src/jobs/context.js';
import { type TestDb, openTestDb } from '../../packages/db/src/testing/index.js';
import { TelegramMock } from './telegram-mock.js';

/** A syntactically valid token; the mock does not check it, but grammY does. */
export const TEST_BOT_TOKEN = '123456789:AAExampleTokenForTestsOnly_0123456789';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-value-0123456789';
/** 32 bytes, base64. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export interface Harness {
  readonly db: TestDb;
  readonly env: Env;
  readonly ctx: AppContext;
  readonly jobCtx: JobContext;
  readonly app: App;
  readonly queue: Queue;
  readonly telegram: TelegramMock;
  readonly registry: BotRegistry;
  now: number;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const db = await openTestDb();
  const telegram = new TelegramMock();
  const apiRoot = await telegram.start();

  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    BOT_TOKEN: TEST_BOT_TOKEN,
    BOT_USERNAME: 'AlnoticaTestBot',
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    WEBHOOK_MODE: 'off',
    PUBLIC_URL: 'https://example.test',
    TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ADMIN_CHAT_ID: '-100500',
  } as NodeJS.ProcessEnv);

  const log = createLogger({ level: 'silent', name: 'test' });
  const queue = createQueue(db.db);

  const harness: Harness = {
    db,
    env,
    telegram,
    queue,
    now: Date.UTC(2024, 5, 3, 9, 0),
    ctx: createContext({ env, log, handle: db }),
    jobCtx: undefined as unknown as JobContext,
    app: undefined as unknown as App,
    registry: undefined as unknown as BotRegistry,
    async reset() {
      await db.reset();
      telegram.reset();
      registry.invalidateAll();
    },
    async close() {
      await app.close();
      await telegram.stop();
      await db.close();
    },
  };

  const registry = new BotRegistry({
    db: db.db,
    log,
    sharedBotToken: TEST_BOT_TOKEN,
    encryptionKey: Buffer.from(TEST_ENCRYPTION_KEY, 'base64'),
    apiRoot,
    configure: (bot, row) => {
      wireBot(bot, {
        db: db.db,
        botRow: row,
        deps: { db: db.db, queue, env, log, registry, nowMs: () => harness.now },
      });
    },
  });

  const jobCtx = createJobContext({
    db: db.db,
    queue,
    env,
    log,
    registry,
    nowMs: () => harness.now,
  });

  const app = createServer(harness.ctx);
  registerHealthRoutes(app, harness.ctx);
  registerWebhookRoutes(app, harness.ctx);
  registerMiniAppRoutes(app, harness.ctx);
  await app.ready();

  return Object.assign(harness, { app, jobCtx, registry });
}

/* --------------------------------- fixtures ------------------------------- */

export interface Fixture {
  readonly bot: BotRow;
  readonly tenant: TenantRow;
  readonly staff: StaffRow;
  readonly service: ServiceRow;
  readonly client: ClientRow;
  readonly repo: ReturnType<typeof forTenant>;
}

export interface SeedOptions {
  readonly slug?: string;
  readonly timezone?: string;
  readonly autoConfirm?: boolean;
  readonly plan?: 'free' | 'pro' | 'team';
  readonly staffTelegramId?: bigint;
  readonly clientTelegramId?: bigint;
  readonly durationMin?: number;
  readonly consent?: boolean;
}

/** A tenant with one master working Mon–Fri 09:00–18:00 and one consenting client. */
export async function seed(h: Harness, options: SeedOptions = {}): Promise<Fixture> {
  const slug =
    options.slug ?? `t${randomUUID().slice(0, 6)}`.toLowerCase().replace(/[^a-z0-9]/g, 'a');
  const bots = botRepo(h.db.db);
  const tenants = tenantRepo(h.db.db);

  const bot = await bots.create({
    mode: 'shared',
    username: `bot_${slug}`,
    botHash: generateBotHash(),
  });
  const tenant = await tenants.create({
    slug,
    title: `Салон ${slug}`,
    kind: 'grooming',
    timezone: options.timezone ?? 'Europe/Moscow',
    botId: bot.id,
  });
  if (options.autoConfirm === false || options.plan) {
    await tenants.update(tenant.id, {
      ...(options.autoConfirm === false ? { autoConfirm: false } : {}),
      ...(options.plan ? { plan: options.plan } : {}),
    });
  }
  const refreshed = (await tenants.byId(tenant.id)) ?? tenant;

  const repo = forTenant(h.db.db, tenant.id);
  const staff = await repo.staff.create({
    telegramId: options.staffTelegramId ?? BigInt(`1000${Math.floor(Math.random() * 1e9)}`),
    name: 'Аня',
    role: 'owner',
  });
  const service = await repo.services.create({
    name: 'Стрижка <люкс>',
    description: null,
    durationMin: options.durationMin ?? 60,
    bufferAfterMin: 0,
    priceMinor: 300_000,
    currency: 'RUB',
    sortOrder: 0,
  });
  await repo.services.link(staff.id, service.id);

  for (const weekday of [1, 2, 3, 4, 5]) {
    await repo.schedule.setWeekday(staff.id, weekday, [
      { startsLocal: '09:00', endsLocal: '18:00' },
    ]);
  }

  const client = await repo.clients.upsertTelegram({
    telegramId: options.clientTelegramId ?? BigInt(`2000${Math.floor(Math.random() * 1e9)}`),
    name: 'Иван',
  });
  if (options.consent !== false) await repo.clients.recordConsent(client.id);
  const withConsent = (await repo.clients.byId(client.id)) ?? client;

  return { bot, tenant: refreshed, staff, service, client: withConsent, repo };
}

export function jobs(h: Harness) {
  return jobRepo(h.db.db);
}

/** A Telegram update as the webhook would receive it. */
export function textUpdate(updateId: number, from: bigint, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(from), type: 'private' },
      from: { id: Number(from), is_bot: false, first_name: 'Иван' },
      text,
    },
  };
}
