import { assertNever } from '../util/assert.js';

/* --------------------------------- tenant --------------------------------- */

export const PLANS = ['free', 'pro', 'team'] as const;
export type Plan = (typeof PLANS)[number];

export const TENANT_KINDS = [
  'grooming',
  'massage',
  'tattoo',
  'tutoring',
  'auto',
  'beauty',
  'other',
] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const BOT_MODES = ['shared', 'dedicated'] as const;
export type BotMode = (typeof BOT_MODES)[number];

export const STAFF_ROLES = ['owner', 'staff'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/* ------------------------------ appointments ------------------------------ */

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'completed',
  'cancelled_by_client',
  'cancelled_by_staff',
  'rescheduled',
  'no_show',
  'expired',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Statuses that occupy time on the calendar. Mirrors the WHERE clause of the
 * `appointment_no_overlap` EXCLUDE constraint — keep the two in sync.
 */
export const BLOCKING_STATUSES = [
  'pending',
  'confirmed',
] as const satisfies readonly AppointmentStatus[];
export type BlockingStatus = (typeof BLOCKING_STATUSES)[number];

export function isBlockingStatus(status: AppointmentStatus): status is BlockingStatus {
  return (BLOCKING_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/** A status from which nothing further can happen. */
export function isTerminalStatus(status: AppointmentStatus): boolean {
  switch (status) {
    case 'pending':
    case 'confirmed':
      return false;
    case 'completed':
    case 'cancelled_by_client':
    case 'cancelled_by_staff':
    case 'rescheduled':
    case 'no_show':
    case 'expired':
      return true;
    default:
      return assertNever(status, 'appointment status');
  }
}

export const APPOINTMENT_CREATORS = ['client', 'staff'] as const;
export type AppointmentCreator = (typeof APPOINTMENT_CREATORS)[number];

/* -------------------------------- broadcast ------------------------------- */

export const BROADCAST_STATUSES = [
  'draft',
  'pending_moderation',
  'approved',
  'rejected',
  'sending',
  'sent',
  'failed',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/* ---------------------------------- media --------------------------------- */

export const MEDIA_KINDS = ['photo', 'video', 'document', 'animation'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/* ---------------------------------- misc ---------------------------------- */

export const CLIENT_SOURCES = ['deeplink', 'manual', 'referral'] as const;
export type ClientSource = (typeof CLIENT_SOURCES)[number];

/** 0 = Sunday … 6 = Saturday, matching JS `Date#getDay` and our `working_hours.weekday`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export function isWeekday(n: number): n is Weekday {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}
