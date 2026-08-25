/**
 * Reminder scheduling. This is the product: automatic reminders are what cut
 * no-shows from ~20% to ~7-8%, so the rules for when a reminder exists — and
 * more importantly when it must be cancelled — live here, pure and tested.
 */
import { DateTime } from 'luxon';

export interface ReminderPlanInput {
  readonly startsAtMs: number;
  readonly nowMs: number;
  /** Minutes before the start, e.g. [1440, 120] for "24 hours" and "2 hours". */
  readonly offsetsMin: readonly number[];
  /** Manually-created clients have never pressed /start, so we cannot message them. */
  readonly clientReachable: boolean;
}

export interface PlannedReminder {
  readonly offsetMin: number;
  readonly runAtMs: number;
}

/**
 * Which reminders should exist for an appointment.
 *
 * A reminder whose moment has already passed is not scheduled at all — booking a
 * slot three hours out must not fire the 24-hour reminder immediately.
 */
export function planReminders(input: ReminderPlanInput): PlannedReminder[] {
  if (!input.clientReachable) return [];
  const out: PlannedReminder[] = [];
  const seen = new Set<number>();
  for (const offsetMin of input.offsetsMin) {
    if (!Number.isFinite(offsetMin) || offsetMin <= 0) continue;
    if (seen.has(offsetMin)) continue;
    seen.add(offsetMin);
    const runAtMs = input.startsAtMs - offsetMin * 60_000;
    if (runAtMs <= input.nowMs) continue;
    out.push({ offsetMin, runAtMs });
  }
  return out.sort((a, b) => a.runAtMs - b.runAtMs);
}

/**
 * Every job belonging to an appointment carries this key, so cancelling or
 * rescheduling can extinguish all of them with a single UPDATE. Getting this
 * wrong is the classic failure of this product category: the client cancels and
 * the bot reminds them anyway.
 */
export function appointmentCancelKey(appointmentId: string): string {
  return `appt:${appointmentId}`;
}

export function tenantCancelKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function broadcastCancelKey(broadcastId: string): string {
  return `broadcast:${broadcastId}`;
}

/** Dedupe key for a single reminder, so re-planning never doubles it up. */
export function reminderDedupeKey(appointmentId: string, offsetMin: number): string {
  return `reminder:${appointmentId}:${offsetMin}`;
}

export function askNoShowDedupeKey(appointmentId: string): string {
  return `ask_no_show:${appointmentId}`;
}

export function digestDedupeKey(tenantId: string, localDate: string): string {
  return `digest:${tenantId}:${localDate}`;
}

/**
 * When the daily "here is tomorrow" digest for a tenant should run: 20:00 in the
 * tenant's own zone, on the next day that has not already passed.
 */
export function nextDigestRunAtMs(nowMs: number, timezone: string, hourLocal = 20): number {
  const now = DateTime.fromMillis(nowMs, { zone: timezone });
  if (!now.isValid) return nowMs + 24 * 3_600_000;
  let target = now.startOf('day').set({ hour: hourLocal });
  if (target <= now) target = target.plus({ days: 1 });
  return target.toMillis();
}

/** The local date the digest covers — the day after the digest is sent. */
export function digestTargetDate(runAtMs: number, timezone: string): string {
  return DateTime.fromMillis(runAtMs, { zone: timezone }).plus({ days: 1 }).toFormat('yyyy-MM-dd');
}
