import type { BotRow, Database } from '@alnotica/db';
import { botRepo } from '@alnotica/db';
/**
 * Bot registry.
 *
 * Every outgoing call goes through the bot that owns the conversation: a shared
 * bot for most tenants, a dedicated one for those on a paid plan. Splitting on
 * `botId` from day one costs one column; retrofitting it onto a single-bot
 * architecture costs a rewrite.
 *
 * Instances are created lazily and cached. Rotating a token invalidates the entry
 * so the next call builds a fresh client rather than using the old token forever.
 */
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot } from 'grammy';
import type { Logger } from 'pino';
import { decryptSecret } from '../crypto.js';

export interface BotRegistryOptions {
  readonly db: Database;
  readonly log: Logger;
  /** Token of the shared bot, from the environment rather than the database. */
  readonly sharedBotToken: string;
  readonly encryptionKey: Buffer;
  /** Overridable so tests can point grammY at a mock HTTP server. */
  readonly apiRoot?: string;
  /** Lets the worker attach its handlers to every bot it creates. */
  readonly configure?: (bot: Bot, row: BotRow) => void;
}

export interface ResolvedBot {
  readonly row: BotRow;
  readonly bot: Bot;
  readonly token: string;
}

/**
 * Throttler settings.
 *
 * Telegram allows roughly 30 messages a second overall and one a second to any
 * single chat. Mass sends run in the queue's slow lane so that a broadcast can
 * never delay a booking confirmation.
 */
const THROTTLER_OPTIONS = {
  global: { maxConcurrent: 30, minTime: 34 },
  group: {
    maxConcurrent: 1,
    minTime: 1000,
    reservoir: 20,
    reservoirRefreshAmount: 20,
    reservoirRefreshInterval: 60_000,
  },
  out: { maxConcurrent: 1, minTime: 1000 },
};

export class BotRegistry {
  private readonly cache = new Map<string, ResolvedBot>();
  private readonly repo: ReturnType<typeof botRepo>;

  constructor(private readonly options: BotRegistryOptions) {
    this.repo = botRepo(options.db);
  }

  /** Builds a configured grammY client. Public so tests can build one directly. */
  createBot(token: string, row?: BotRow): Bot {
    const bot = new Bot(token, {
      ...(this.options.apiRoot ? { client: { apiRoot: this.options.apiRoot } } : {}),
    });
    // Order matters: the throttler is installed first so that it also paces the
    // extra calls auto-retry makes.
    bot.api.config.use(apiThrottler(THROTTLER_OPTIONS));
    bot.api.config.use(
      autoRetry({
        // Past three attempts the job goes back into the queue with a delay rather
        // than blocking a worker slot on a long `retry_after`.
        maxRetryAttempts: 3,
        maxDelaySeconds: 30,
        rethrowInternalServerErrors: true,
      }),
    );
    if (row) this.options.configure?.(bot, row);
    return bot;
  }

  private tokenFor(row: BotRow): string {
    if (row.mode === 'shared') return this.options.sharedBotToken;
    if (!row.tokenEncrypted) throw new Error(`dedicated bot ${row.id} has no token`);
    return decryptSecret(Buffer.from(row.tokenEncrypted), this.options.encryptionKey);
  }

  async byId(botId: string): Promise<ResolvedBot | null> {
    const cached = this.cache.get(botId);
    if (cached) return cached;

    const row = await this.repo.byId(botId);
    if (!row || !row.isActive) return null;

    const token = this.tokenFor(row);
    const bot = this.createBot(token, row);
    await bot.init();

    const resolved: ResolvedBot = { row, bot, token };
    this.cache.set(botId, resolved);
    // The token is never logged, here or anywhere else.
    this.options.log.info({ botId, mode: row.mode, username: row.username }, 'bot initialised');
    return resolved;
  }

  /** Called after a token rotation or a deactivation. */
  invalidate(botId: string): void {
    this.cache.delete(botId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
