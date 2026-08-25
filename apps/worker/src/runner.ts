/**
 * The queue loop.
 *
 * Claims a batch, runs it with bounded concurrency, and classifies each outcome.
 * On SIGTERM it stops claiming and lets what is in flight finish — a half-sent
 * reminder is worse than a slightly slower deploy.
 */
import type { Queue } from '@alnotica/core';
import type { JobRow } from '@alnotica/db';
import { jobRepo } from '@alnotica/db';
import { type JobPayload, assertNever, backoffMs } from '@alnotica/shared';
import { handleAskNoShow } from './jobs/ask-no-show.js';
import { handleBroadcastChunk } from './jobs/broadcast.js';
import { type JobContext, JobRetryLater, JobSkipped } from './jobs/context.js';
import { handleDailyDigest } from './jobs/daily-digest.js';
import { handleNotifyBooking } from './jobs/notify-booking.js';
import { handleProcessUpdate } from './jobs/process-update.js';
import { handleReminder } from './jobs/reminder.js';
import { handleSendMessage } from './jobs/send-message.js';

export async function runJob(ctx: JobContext, payload: JobPayload): Promise<void> {
  switch (payload.kind) {
    case 'process_update':
      return handleProcessUpdate(ctx, payload);
    case 'send_message':
      return handleSendMessage(ctx, payload);
    case 'reminder':
      return handleReminder(ctx, payload);
    case 'ask_no_show':
      return handleAskNoShow(ctx, payload);
    case 'daily_digest':
      return handleDailyDigest(ctx, payload);
    case 'broadcast_chunk':
      return handleBroadcastChunk(ctx, payload);
    case 'notify_booking':
      return handleNotifyBooking(ctx, payload);
    default:
      return assertNever(payload, 'job payload');
  }
}

export interface RunnerOptions {
  readonly workerId: string;
  readonly concurrency: number;
  readonly queue: Queue;
}

export interface BatchResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly retried: number;
  readonly dead: number;
}

/** Claims and processes one batch. Returns what happened, for the logs. */
export async function processBatch(ctx: JobContext, options: RunnerOptions): Promise<BatchResult> {
  const { jobs, poisoned } = await options.queue.claim(
    options.workerId,
    options.concurrency,
    ctx.now(),
  );

  // A payload this build cannot parse is buried immediately: retrying it would
  // just fail identically five more times.
  const repo = jobRepo(ctx.db);
  for (const row of poisoned) {
    ctx.log.error({ jobId: row.id, kind: row.kind }, 'job payload failed validation');
    await repo.fail(row.id, 'payload failed validation', null);
  }

  let succeeded = 0;
  let skipped = 0;
  let retried = 0;
  let dead = poisoned.length;

  await Promise.all(
    jobs.map(async ({ row, payload }) => {
      try {
        await runJob(ctx, payload);
        await options.queue.succeed(row.id);
        succeeded++;
      } catch (error) {
        const outcome = await classify(ctx, options.queue, row, error);
        if (outcome === 'skipped') skipped++;
        else if (outcome === 'retry') retried++;
        else dead++;
      }
    }),
  );

  return { claimed: jobs.length + poisoned.length, succeeded, skipped, retried, dead };
}

async function classify(
  ctx: JobContext,
  queue: Queue,
  row: JobRow,
  error: unknown,
): Promise<'skipped' | 'retry' | 'dead'> {
  const repo = jobRepo(ctx.db);

  // The job's premise no longer holds — the appointment was cancelled, the client
  // blocked the bot. That is a finished job, not a failed one.
  if (error instanceof JobSkipped) {
    ctx.log.debug({ jobId: row.id, kind: row.kind, reason: error.message }, 'job skipped');
    await queue.succeed(row.id);
    return 'skipped';
  }

  // Telegram told us exactly how long to wait; honour it instead of backing off
  // blindly, and free the worker in the meantime. The attempt budget still
  // applies: a chat that floods us forever must eventually be given up on, or the
  // job cycles for the lifetime of the deployment.
  if (error instanceof JobRetryLater) {
    if (row.attempts >= row.maxAttempts) {
      ctx.log.error({ jobId: row.id, kind: row.kind }, 'job exhausted its attempts while deferred');
      await repo.fail(row.id, error.message, null);
      return 'dead';
    }
    ctx.log.info({ jobId: row.id, retryAfterSec: error.retryAfterSec }, 'job deferred by telegram');
    await repo.fail(row.id, error.message, new Date(ctx.now() + error.retryAfterSec * 1000));
    return 'retry';
  }

  ctx.log.error(
    { err: error, jobId: row.id, kind: row.kind, attempts: row.attempts },
    'job failed',
  );
  const result = await queue.fail(row, error);
  if (result === 'dead') {
    ctx.log.error({ jobId: row.id, kind: row.kind }, 'job exhausted its attempts');
  }
  return result === 'dead' ? 'dead' : 'retry';
}

export { backoffMs };
