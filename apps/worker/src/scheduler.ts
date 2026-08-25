/**
 * Periodic work that nothing else triggers.
 *
 * Everything here is idempotent and guarded by a dedupe key, so running the
 * scheduler in two workers at once is harmless.
 */
import { forTenant } from '@alnotica/db';
import {
  ASK_NO_SHOW_DELAY_MIN,
  PENDING_TTL_MIN,
  PRIORITY,
  appointmentCancelKey,
  askNoShowDedupeKey,
  digestDedupeKey,
  digestTargetDate,
  nextDigestRunAtMs,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import type { JobContext } from './jobs/context.js';

/**
 * Unconfirmed bookings that have waited longer than the TTL become `expired`,
 * which releases the slot for everyone else.
 */
export async function expirePending(ctx: JobContext): Promise<number> {
  const cutoff = new Date(ctx.now() - PENDING_TTL_MIN * 60_000);
  const tenants = await ctx.tenants.listActive();

  let expired = 0;
  for (const tenant of tenants) {
    if (tenant.autoConfirm) continue; // nothing is ever pending here
    const repo = forTenant(ctx.db, tenant.id);
    // Includes bookings whose start has already passed: an unconfirmed one that
    // was simply never answered still has to release its slot and stop reminding.
    const stale = await repo.appointments.pendingCreatedBefore(cutoff.getTime());
    for (const appointment of stale) {
      const updated = await repo.appointments.transition(appointment.id, ['pending'], 'expired');
      if (!updated) continue;
      expired++;
      // Expiring must extinguish the reminders too, exactly like a cancellation.
      await ctx.queue.cancelByKey(appointmentCancelKey(appointment.id));

      const [staff, client] = await Promise.all([
        repo.staff.byId(appointment.staffId),
        repo.clients.byId(appointment.clientId),
      ]);
      if (staff) {
        await ctx.queue.enqueue({
          kind: 'send_message',
          payload: {
            kind: 'send_message',
            botId: tenant.botId,
            chatId: staff.telegramId.toString(),
            text: 'Заявка не подтверждена в течение часа и снята.',
            disablePreview: true,
            marketing: false,
            tenantId: tenant.id,
          },
          priority: PRIORITY.transactional,
          dedupeKey: `expired_staff:${appointment.id}`,
        });
      }
      if (client?.telegramId && !client.isBlocked) {
        await ctx.queue.enqueue({
          kind: 'send_message',
          payload: {
            kind: 'send_message',
            botId: tenant.botId,
            chatId: client.telegramId.toString(),
            text: 'Заявка не была подтверждена и снята. Попробуйте выбрать другое время.',
            disablePreview: true,
            marketing: false,
            tenantId: tenant.id,
            clientId: client.id,
          },
          priority: PRIORITY.transactional,
          dedupeKey: `expired_client:${appointment.id}`,
        });
      }
    }
  }
  return expired;
}

/**
 * A safety net for the no-show question. It is normally scheduled at booking
 * time; this catches appointments created before that path existed, or whose job
 * was lost. The dedupe key makes a double-ask impossible either way.
 */
export async function enqueueNoShowQuestions(ctx: JobContext): Promise<number> {
  const nowMs = ctx.now();
  const cutoff = nowMs - ASK_NO_SHOW_DELAY_MIN * 60_000;
  const tenants = await ctx.tenants.listActive();

  let queued = 0;
  for (const tenant of tenants) {
    const repo = forTenant(ctx.db, tenant.id);
    const pending = await repo.appointments.awaitingOutcome(cutoff, 100);
    for (const appointment of pending) {
      const created = await ctx.queue.enqueue({
        kind: 'ask_no_show',
        payload: { kind: 'ask_no_show', appointmentId: appointment.id },
        priority: PRIORITY.transactional,
        cancelKey: appointmentCancelKey(appointment.id),
        dedupeKey: askNoShowDedupeKey(appointment.id),
      });
      if (created) queued++;
    }
  }
  return queued;
}

/** Schedules tomorrow's digest at 20:00 in each tenant's own zone. */
export async function scheduleDigests(ctx: JobContext): Promise<number> {
  const nowMs = ctx.now();
  const tenants = await ctx.tenants.listActive();

  let queued = 0;
  for (const tenant of tenants) {
    const runAtMs = nextDigestRunAtMs(nowMs, tenant.timezone);
    // Only schedule the one that is actually next; a day ahead is enough lead.
    if (runAtMs - nowMs > 25 * 3_600_000) continue;

    const targetDate = digestTargetDate(runAtMs, tenant.timezone);
    const created = await ctx.queue.enqueue({
      kind: 'daily_digest',
      payload: { kind: 'daily_digest', tenantId: tenant.id, targetDate },
      priority: PRIORITY.digest,
      runAt: new Date(runAtMs),
      dedupeKey: digestDedupeKey(tenant.id, targetDate),
    });
    if (created) queued++;
  }
  return queued;
}

/** Marks past confirmed visits as completed once the master never answered. */
export async function autoComplete(ctx: JobContext, afterHours = 48): Promise<number> {
  const cutoff = ctx.now() - afterHours * 3_600_000;
  const tenants = await ctx.tenants.listActive();

  let completed = 0;
  for (const tenant of tenants) {
    const repo = forTenant(ctx.db, tenant.id);
    const stale = await repo.appointments.awaitingOutcome(cutoff, 200);
    for (const appointment of stale) {
      // No answer after two days: assume the visit happened. Guessing "no-show"
      // instead would inflate the metric the master is judged on.
      const updated = await repo.appointments.transition(
        appointment.id,
        ['confirmed'],
        'completed',
      );
      if (updated) completed++;
    }
  }
  return completed;
}

/** Housekeeping so the tables the queue writes to do not grow without bound. */
export async function prune(ctx: JobContext): Promise<void> {
  const weekAgo = new Date(ctx.now() - 7 * 86_400_000);
  await ctx.updates.pruneOlderThan(weekAgo);
}

export interface SchedulerTask {
  readonly name: string;
  readonly everyMs: number;
  run(ctx: JobContext): Promise<unknown>;
}

export const SCHEDULER_TASKS: readonly SchedulerTask[] = [
  { name: 'expire_pending', everyMs: 60_000, run: expirePending },
  { name: 'ask_no_show', everyMs: 5 * 60_000, run: enqueueNoShowQuestions },
  { name: 'daily_digest', everyMs: 15 * 60_000, run: scheduleDigests },
  { name: 'auto_complete', everyMs: 60 * 60_000, run: (ctx) => autoComplete(ctx) },
  { name: 'prune', everyMs: 6 * 3_600_000, run: prune },
];

/** Which tasks are due at `nowMs`, given when each last ran. */
export function dueTasks(
  lastRun: ReadonlyMap<string, number>,
  nowMs: number,
  tasks: readonly SchedulerTask[] = SCHEDULER_TASKS,
): SchedulerTask[] {
  return tasks.filter((task) => nowMs - (lastRun.get(task.name) ?? 0) >= task.everyMs);
}

export { DateTime };
