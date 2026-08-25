/**
 * The queue is a table. At 20 000 outbound messages a day on a single box, a
 * broker would be one more thing to run, back up and lose; a table gives us
 * transactional enqueueing (a booking and its reminders commit together) for free.
 */
import { and, desc, eq, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { isUniqueViolation } from '../client.js';
import { type JobRow, job } from '../schema.js';

export interface EnqueueInput {
  readonly kind: string;
  readonly payload: unknown;
  readonly priority?: number;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  /** Unique; a second enqueue with the same key is silently dropped. */
  readonly dedupeKey?: string | null;
  /** Groups jobs so one UPDATE can extinguish them all. */
  readonly cancelKey?: string | null;
}

/** A job whose lock is older than this is assumed to have died with its worker. */
export const LOCK_TIMEOUT_MIN = 5;

export function jobRepo(db: Database) {
  return {
    /**
     * Adds a job. Returns null when `dedupeKey` collides with a live job, which is
     * the normal outcome of re-planning reminders for an unchanged appointment.
     */
    async enqueue(input: EnqueueInput): Promise<JobRow | null> {
      try {
        const rows = await db
          .insert(job)
          .values({
            kind: input.kind,
            payload: input.payload as never,
            priority: input.priority ?? 100,
            runAt: input.runAt ?? new Date(),
            maxAttempts: input.maxAttempts ?? 5,
            dedupeKey: input.dedupeKey ?? null,
            cancelKey: input.cancelKey ?? null,
          })
          .onConflictDoNothing({ target: job.dedupeKey })
          .returning();
        return rows[0] ?? null;
      } catch (e) {
        if (isUniqueViolation(e)) return null;
        throw e;
      }
    },

    async enqueueMany(inputs: readonly EnqueueInput[]): Promise<number> {
      if (inputs.length === 0) return 0;
      const rows = await db
        .insert(job)
        .values(
          inputs.map((i) => ({
            kind: i.kind,
            payload: i.payload as never,
            priority: i.priority ?? 100,
            runAt: i.runAt ?? new Date(),
            maxAttempts: i.maxAttempts ?? 5,
            dedupeKey: i.dedupeKey ?? null,
            cancelKey: i.cancelKey ?? null,
          })),
        )
        .onConflictDoNothing({ target: job.dedupeKey })
        .returning({ id: job.id });
      return rows.length;
    },

    /**
     * Claims up to `limit` due jobs for this worker.
     *
     * `FOR UPDATE SKIP LOCKED` inside the sub-select is what lets several workers
     * pull from the same table without blocking each other or handing the same job
     * to two of them. Locks older than `LOCK_TIMEOUT_MIN` are reclaimed, so a
     * worker killed mid-job does not strand its work.
     */
    async claim(workerId: string, limit: number, now = new Date()): Promise<JobRow[]> {
      const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MIN * 60_000);
      // Timestamps are passed as ISO strings with an explicit cast: the raw-SQL
      // path hands parameters to the driver untyped, and an untyped Date does not
      // survive the wire protocol.
      const nowIso = now.toISOString();
      const staleIso = staleBefore.toISOString();
      // The raw shape before the timestamps are converted below.
      type RawJobRow = Omit<JobRow, 'runAt' | 'lockedAt' | 'finishedAt'> & {
        runAt: string;
        lockedAt: string | null;
        finishedAt: string | null;
      };
      const rows = await db.execute<RawJobRow>(sql`
        UPDATE ${job}
           SET locked_at = ${nowIso}::timestamptz,
               locked_by = ${workerId},
               attempts  = ${job.attempts} + 1
         WHERE id IN (
           SELECT id FROM ${job}
            WHERE finished_at IS NULL
              AND run_at <= ${nowIso}::timestamptz
              AND (locked_at IS NULL OR locked_at < ${staleIso}::timestamptz)
            ORDER BY priority ASC, run_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, kind, payload, priority, run_at AS "runAt", attempts,
                  max_attempts AS "maxAttempts", locked_at AS "lockedAt",
                  locked_by AS "lockedBy", finished_at AS "finishedAt",
                  last_error AS "lastError", dedupe_key AS "dedupeKey",
                  cancel_key AS "cancelKey"
      `);
      // Raw SQL bypasses Drizzle's column mapping, so the timestamps arrive as
      // text. Converting them here keeps `JobRow` honest: a field typed `Date`
      // that is really a string is the kind of lie that bites three files away.
      const claimed: JobRow[] = [...rows].map((row) => ({
        ...row,
        runAt: new Date(row.runAt),
        lockedAt: row.lockedAt === null ? null : new Date(row.lockedAt),
        finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt),
      }));

      // UPDATE ... RETURNING gives no ordering guarantee, so the priority order
      // the sub-select established is re-applied before the jobs are handed out.
      return claimed.sort(
        (a, b) => a.priority - b.priority || a.runAt.getTime() - b.runAt.getTime(),
      );
    },

    /** Marks a job done. Clearing `last_error` is what makes "dead" derivable. */
    async succeed(id: number): Promise<void> {
      await db
        .update(job)
        .set({ finishedAt: new Date(), lastError: null, lockedAt: null, lockedBy: null })
        .where(eq(job.id, id));
    },

    /** Reschedules a failed job, or buries it once it is out of attempts. */
    async fail(id: number, error: string, retryAt: Date | null): Promise<'retry' | 'dead'> {
      if (retryAt === null) {
        await db
          .update(job)
          .set({
            finishedAt: new Date(),
            lastError: error.slice(0, 2000),
            lockedAt: null,
            lockedBy: null,
          })
          .where(eq(job.id, id));
        return 'dead';
      }
      await db
        .update(job)
        .set({ runAt: retryAt, lastError: error.slice(0, 2000), lockedAt: null, lockedBy: null })
        .where(eq(job.id, id));
      return 'retry';
    },

    /**
     * Extinguishes every unfinished job in a group.
     *
     * This is the single most important query in the reminder pipeline: a client
     * who cancels and still gets reminded has lost trust in the product.
     *
     * The dedupe key is released as well. Without that, a reschedule that has to
     * be rolled back could never re-create the reminders it just cancelled — the
     * dead row would keep claiming the key and every re-insert would be silently
     * dropped, leaving the restored appointment with no reminders at all.
     */
    async cancelByKey(cancelKey: string): Promise<number> {
      const rows = await db
        .update(job)
        .set({ finishedAt: new Date(), lastError: 'cancelled', dedupeKey: null })
        .where(and(eq(job.cancelKey, cancelKey), isNull(job.finishedAt)))
        .returning({ id: job.id });
      return rows.length;
    },

    async byId(id: number): Promise<JobRow | null> {
      const [row] = await db.select().from(job).where(eq(job.id, id)).limit(1);
      return row ?? null;
    },

    /** Unfinished jobs in a group — used by tests and by the appointment card. */
    async pendingByCancelKey(cancelKey: string): Promise<JobRow[]> {
      return db
        .select()
        .from(job)
        .where(and(eq(job.cancelKey, cancelKey), isNull(job.finishedAt)));
    },

    /** Queue depth, for the alerting job. */
    async depth(now = new Date()): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(job)
        .where(and(isNull(job.finishedAt), lte(job.runAt, now)));
      return row?.n ?? 0;
    },

    /**
     * Jobs the worker gave up on, for the admin panel.
     *
     * Derived rather than stored: a job is dead when it is finished and still
     * carries an error. A successful run clears `last_error`, and a cancellation
     * writes the sentinel 'cancelled', so neither shows up here.
     */
    async dead(limit = 50): Promise<JobRow[]> {
      return db
        .select()
        .from(job)
        .where(
          and(isNotNull(job.finishedAt), isNotNull(job.lastError), ne(job.lastError, 'cancelled')),
        )
        .orderBy(desc(job.id))
        .limit(limit);
    },

    async pruneFinishedBefore(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(job)
        .where(and(isNotNull(job.finishedAt), lt(job.finishedAt, cutoff)))
        .returning({ id: job.id });
      return rows.length;
    },
  };
}

export type JobRepo = ReturnType<typeof jobRepo>;
