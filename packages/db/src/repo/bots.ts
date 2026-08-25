import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type BotRow, bot } from '../schema.js';

export interface CreateBotInput {
  readonly mode: 'shared' | 'dedicated';
  readonly username: string;
  readonly botHash: string;
  readonly tokenEncrypted?: Buffer | null;
}

export function botRepo(db: Database) {
  return {
    async create(input: CreateBotInput): Promise<BotRow> {
      const [row] = await db
        .insert(bot)
        .values({
          mode: input.mode,
          username: input.username,
          botHash: input.botHash,
          tokenEncrypted: input.tokenEncrypted ?? null,
        })
        .returning();
      if (!row) throw new Error('insert into bot returned nothing');
      return row;
    },

    async byId(id: string): Promise<BotRow | null> {
      const [row] = await db.select().from(bot).where(eq(bot.id, id)).limit(1);
      return row ?? null;
    },

    /** Resolves the unguessable webhook path segment to a bot. */
    async byHash(botHash: string): Promise<BotRow | null> {
      const [row] = await db.select().from(bot).where(eq(bot.botHash, botHash)).limit(1);
      return row ?? null;
    },

    async byUsername(username: string): Promise<BotRow | null> {
      const [row] = await db.select().from(bot).where(eq(bot.username, username)).limit(1);
      return row ?? null;
    },

    async listActive(): Promise<BotRow[]> {
      return db.select().from(bot).where(eq(bot.isActive, true));
    },

    async markWebhookSet(id: string): Promise<void> {
      await db.update(bot).set({ webhookSetAt: new Date() }).where(eq(bot.id, id));
    },

    /** Rotating a token invalidates the cached grammY instance for this bot. */
    async setToken(id: string, tokenEncrypted: Buffer): Promise<void> {
      await db.update(bot).set({ tokenEncrypted, webhookSetAt: null }).where(eq(bot.id, id));
    },

    async deactivate(id: string): Promise<void> {
      await db.update(bot).set({ isActive: false }).where(eq(bot.id, id));
    },
  };
}

export type BotRepo = ReturnType<typeof botRepo>;
