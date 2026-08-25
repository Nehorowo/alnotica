/**
 * A thin, typed face over the `job` table.
 *
 * Payloads are validated with Zod on the way in *and* on the way out: a row in
 * the queue may have been written by an older deployment, so it is untrusted data
 * exactly like an HTTP body.
 */
import { type Database, type JobRow, jobRepo } from '@alnotica/db';
import {
  type JobKind,
  type JobPayload,
  MAX_ATTEMPTS,
  backoffMs,
  jobPayloadSchema,
} from '@alnotica/shared';

export interface EnqueueOptions {
  readonly kind: JobKind;
  readonly payload: JobPayload;
  readonly priority?: number;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  readonly dedupeKey?: string | null;
  readonly cancelKey?: string | null;
}

export interface ClaimedJob {
  readonly row: JobRow;
  readonly payload: JobPayload;
}

export interface Queue {
  enqueue(options: EnqueueOptions): Promise<JobRow | null>;
  enqueueMany(options: readonly EnqueueOptions[]): Promise<number>;
  cancelByKey(cancelKey: string): Promise<number>;
  claim(
    workerId: string,
    limit: number,
    nowMs?: number,
  ): Promise<{ jobs: ClaimedJob[]; poisoned: JobRow[] }>;
  succeed(id: number): Promise<void>;
  fail(row: JobRow, error: unknown): Promise<'retry' | 'dead'>;
  depth(): Promise<number>;
}

export function createQueue(db: Database): Queue {
  const repo = jobRepo(db);

  return {
    async enqueue(options) {
      // Validating here means a bad payload fails at the call site, with a stack
      // that points at the bug rather than at the worker.
      const payload = jobPayloadSchema.parse(options.payload);
      return repo.enqueue({
        kind: options.kind,
        payload,
        priority: options.priority ?? 100,
        runAt: options.runAt ?? new Date(),
        maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
        dedupeKey: options.dedupeKey ?? null,
        cancelKey: options.cancelKey ?? null,
      });
    },

    async enqueueMany(options) {
      return repo.enqueueMany(
        options.map((o) => ({
          kind: o.kind,
          payload: jobPayloadSchema.parse(o.payload),
          priority: o.priority ?? 100,
          runAt: o.runAt ?? new Date(),
          maxAttempts: o.maxAttempts ?? MAX_ATTEMPTS,
          dedupeKey: o.dedupeKey ?? null,
          cancelKey: o.cancelKey ?? null,
        })),
      );
    },

    cancelByKey: (cancelKey) => repo.cancelByKey(cancelKey),

    async claim(workerId, limit, nowMs) {
      const rows = await repo.claim(
        workerId,
        limit,
        nowMs === undefined ? undefined : new Date(nowMs),
      );
      const jobs: ClaimedJob[] = [];
      const poisoned: JobRow[] = [];
      for (const row of rows) {
        const parsed = jobPayloadSchema.safeParse(row.payload);
        if (parsed.success) jobs.push({ row, payload: parsed.data });
        else poisoned.push(row);
      }
      return { jobs, poisoned };
    },

    succeed: (id) => repo.succeed(id),

    /**
     * Retries with `2^attempts` minutes of backoff, capped at six hours; buries the
     * job once the attempt budget is spent.
     */
    async fail(row, error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (row.attempts >= row.maxAttempts) return repo.fail(row.id, message, null);
      return repo.fail(row.id, message, new Date(Date.now() + backoffMs(row.attempts)));
    },

    depth: () => repo.depth(),
  };
}
