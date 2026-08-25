import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type TgUpdateRow, tgUpdate } from '../schema.js';

export interface RecordUpdateResult {
  readonly row: TgUpdateRow | null;
  /** True when Telegram had already delivered this update and we ignored it. */
  readonly duplicate: boolean;
}

export function updateRepo(db: Database) {
  return {
    /**
     * Stores an incoming update. Telegram retries any update we do not answer with
     * a 200 fast enough, so the unique `(bot_id, update_id)` index is what turns a
     * retry into a silent no-op instead of a second booking.
     */
    async record(botId: string, updateId: number, payload: unknown): Promise<RecordUpdateResult> {
      const rows = await db
        .insert(tgUpdate)
        .values({ botId, updateId, payload })
        .onConflictDoNothing({ target: [tgUpdate.botId, tgUpdate.updateId] })
        .returning();
      const row = rows[0];
      return row ? { row, duplicate: false } : { row: null, duplicate: true };
    },

    async byId(id: number): Promise<TgUpdateRow | null> {
      const [row] = await db.select().from(tgUpdate).where(eq(tgUpdate.id, id)).limit(1);
      return row ?? null;
    },

    async markProcessed(id: number, error?: string): Promise<void> {
      await db
        .update(tgUpdate)
        .set({ processedAt: new Date(), error: error ?? null })
        .where(eq(tgUpdate.id, id));
    },

    /** Feeds the "how stale is the newest processed update" alert. */
    async lastProcessedAt(): Promise<Date | null> {
      const [row] = await db
        .select({ at: sql<string | null>`max(${tgUpdate.processedAt})` })
        .from(tgUpdate);
      // Drizzle hands back the raw text for an expression it did not build itself.
      return row?.at ? new Date(row.at) : null;
    },

    async unprocessedCount(): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tgUpdate)
        .where(isNull(tgUpdate.processedAt));
      return row?.n ?? 0;
    },

    /** Housekeeping: processed updates are only useful for a few days. */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(tgUpdate)
        .where(and(lt(tgUpdate.receivedAt, cutoff), isNotNull(tgUpdate.processedAt)))
        .returning({ id: tgUpdate.id });
      return rows.length;
    },
  };
}

export type UpdateRepo = ReturnType<typeof updateRepo>;
