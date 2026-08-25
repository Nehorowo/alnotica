/**
 * The objects every route needs, built once at boot and passed explicitly.
 * No module-level singletons: a test builds its own context against its own
 * database instead of monkey-patching a global.
 */
import {
  type Env,
  type Queue,
  createQueue,
  decryptSecret,
  parseEncryptionKey,
} from '@alnotica/core';
import type { BotRow, Database, DbHandle } from '@alnotica/db';
import { botRepo, jobRepo, tenantRepo, updateRepo } from '@alnotica/db';
import type { Logger } from 'pino';

export interface AppContext {
  readonly env: Env;
  readonly log: Logger;
  readonly db: Database;
  readonly handle: DbHandle;
  readonly bots: ReturnType<typeof botRepo>;
  readonly tenants: ReturnType<typeof tenantRepo>;
  readonly updates: ReturnType<typeof updateRepo>;
  readonly jobs: ReturnType<typeof jobRepo>;
  readonly queue: Queue;
  /**
   * The bot token used to verify `initData`. Never returned by any route and
   * never logged — it is only ever fed to an HMAC.
   */
  tokenFor(bot: BotRow): Promise<string>;
}

export function createContext(input: { env: Env; log: Logger; handle: DbHandle }): AppContext {
  const { db } = input.handle;
  const encryptionKey = parseEncryptionKey(input.env.TOKEN_ENCRYPTION_KEY);
  return {
    env: input.env,
    log: input.log,
    db,
    handle: input.handle,
    bots: botRepo(db),
    tenants: tenantRepo(db),
    updates: updateRepo(db),
    jobs: jobRepo(db),
    queue: createQueue(db),
    async tokenFor(bot: BotRow): Promise<string> {
      if (bot.mode === 'shared') return input.env.BOT_TOKEN;
      if (!bot.tokenEncrypted) throw new Error(`dedicated bot ${bot.id} has no token`);
      return decryptSecret(Buffer.from(bot.tokenEncrypted), encryptionKey);
    },
  };
}
