/**
 * Appointment lifecycle. Pure and I/O free.
 *
 *   pending ──confirm──> confirmed ──(time passed)──> completed
 *      │                     ├──cancel_by_client──> cancelled_by_client
 *      │                     ├──cancel_by_staff───> cancelled_by_staff
 *      │                     ├──reschedule────────> rescheduled (+ a new appointment)
 *      │                     └──mark_no_show─────> no_show
 *      └──expire (not confirmed within 60 min)──> expired
 */
import { InvalidTransitionError, OutsideCancelWindowError } from '../errors.js';
import type { AppointmentStatus } from '../types/index.js';
import { assertNever } from '../util/assert.js';

export const APPOINTMENT_ACTIONS = [
  'confirm',
  'complete',
  'cancel_by_client',
  'cancel_by_staff',
  'reschedule',
  'mark_no_show',
  'expire',
] as const;
export type AppointmentAction = (typeof APPOINTMENT_ACTIONS)[number];

/** How long an unconfirmed appointment survives before it expires. */
export const PENDING_TTL_MIN = 60;

/** How long after the end of a visit the bot asks the master whether the client showed up. */
export const ASK_NO_SHOW_DELAY_MIN = 120;

/**
 * The full transition table. Anything not listed here is rejected. Written as an
 * exhaustive `switch` rather than a lookup object so that adding a status to the
 * union breaks the build here first.
 */
export function nextStatus(from: AppointmentStatus, action: AppointmentAction): AppointmentStatus {
  switch (from) {
    case 'pending':
      switch (action) {
        case 'confirm':
          return 'confirmed';
        case 'cancel_by_client':
          return 'cancelled_by_client';
        case 'cancel_by_staff':
          return 'cancelled_by_staff';
        case 'reschedule':
          return 'rescheduled';
        case 'expire':
          return 'expired';
        case 'complete':
        case 'mark_no_show':
          throw new InvalidTransitionError(from, action);
        default:
          return assertNever(action, 'appointment action');
      }
    case 'confirmed':
      switch (action) {
        case 'complete':
          return 'completed';
        case 'cancel_by_client':
          return 'cancelled_by_client';
        case 'cancel_by_staff':
          return 'cancelled_by_staff';
        case 'reschedule':
          return 'rescheduled';
        case 'mark_no_show':
          return 'no_show';
        case 'confirm':
        case 'expire':
          throw new InvalidTransitionError(from, action);
        default:
          return assertNever(action, 'appointment action');
      }
    // Terminal statuses accept nothing. `completed` <-> `no_show` correction is
    // handled by `correctOutcome`, not by the generic transition path.
    case 'completed':
    case 'cancelled_by_client':
    case 'cancelled_by_staff':
    case 'rescheduled':
    case 'no_show':
    case 'expired':
      throw new InvalidTransitionError(from, action);
    default:
      return assertNever(from, 'appointment status');
  }
}

export function canTransition(from: AppointmentStatus, action: AppointmentAction): boolean {
  try {
    nextStatus(from, action);
    return true;
  } catch (e) {
    if (e instanceof InvalidTransitionError) return false;
    throw e;
  }
}

export function allowedActions(from: AppointmentStatus): AppointmentAction[] {
  return APPOINTMENT_ACTIONS.filter((a) => canTransition(from, a));
}

/**
 * A master who answered "did the client show up?" wrongly must be able to fix it.
 * This is the only path between two terminal statuses, and it is deliberately
 * narrow: it feeds the product's headline metric.
 */
export function correctOutcome(
  from: AppointmentStatus,
  to: 'completed' | 'no_show',
): AppointmentStatus {
  if (from !== 'completed' && from !== 'no_show') {
    throw new InvalidTransitionError(from, `correct_to_${to}`);
  }
  return to;
}

/* ------------------------------ cancellation ------------------------------ */

export interface CancelWindowCheck {
  readonly startsAtMs: number;
  readonly nowMs: number;
  readonly cancelWindowHours: number;
}

/** Whether a client may still cancel on their own. */
export function isWithinCancelWindow({
  startsAtMs,
  nowMs,
  cancelWindowHours,
}: CancelWindowCheck): boolean {
  return startsAtMs - nowMs >= cancelWindowHours * 3_600_000;
}

/** Throws `OutsideCancelWindowError` when the client is too late to self-cancel. */
export function assertClientMayCancel(check: CancelWindowCheck): void {
  if (!isWithinCancelWindow(check)) {
    throw new OutsideCancelWindowError(check.cancelWindowHours);
  }
}

/** The moment a pending appointment stops waiting for confirmation. */
export function pendingExpiresAtMs(createdAtMs: number, ttlMin = PENDING_TTL_MIN): number {
  return createdAtMs + ttlMin * 60_000;
}

/** The moment the bot should ask the master whether the client showed up. */
export function askNoShowAtMs(endsAtMs: number, delayMin = ASK_NO_SHOW_DELAY_MIN): number {
  return endsAtMs + delayMin * 60_000;
}

/** Initial status for a fresh booking. */
export function initialStatus(
  autoConfirm: boolean,
): Extract<AppointmentStatus, 'pending' | 'confirmed'> {
  return autoConfirm ? 'confirmed' : 'pending';
}

/** Whether a status means the visit did not happen through the client's fault. */
export function countsAsNoShow(status: AppointmentStatus): boolean {
  return status === 'no_show';
}

/** Whether a status means the appointment was cancelled by either side. */
export function isCancelled(status: AppointmentStatus): boolean {
  return status === 'cancelled_by_client' || status === 'cancelled_by_staff';
}

/**
 * Statuses that release the calendar slot. Cancelling must drop the appointment
 * out of `BLOCKING_STATUSES` so the EXCLUDE constraint stops guarding the span.
 */
export function releasesSlot(status: AppointmentStatus): boolean {
  return status !== 'pending' && status !== 'confirmed';
}
