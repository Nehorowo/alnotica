/**
 * Plans. Only one limit is enforced in the hot path (free-tier bookings per
 * calendar month); everything else is a gate at the entrance to a section.
 */
import { DateTime } from 'luxon';
import { PlanFeatureError, PlanLimitError } from '../errors.js';
import type { Plan } from '../types/index.js';

export const FREE_MONTHLY_APPOINTMENTS = 30;

export const PLAN_PRICES_MINOR: Record<Plan, number> = {
  free: 0,
  pro: 99_000,
  team: 249_000,
};

/** Yearly billing is 20% off. */
export const YEARLY_DISCOUNT = 0.2;

export function yearlyPriceMinor(plan: Plan): number {
  return Math.round(PLAN_PRICES_MINOR[plan] * 12 * (1 - YEARLY_DISCOUNT));
}

export const PLAN_FEATURES = [
  'dedicated_bot',
  'broadcasts',
  'multi_staff',
  'miniapp_staff',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

const FEATURE_MATRIX: Record<Plan, readonly PlanFeature[]> = {
  free: [],
  pro: ['dedicated_bot', 'broadcasts', 'miniapp_staff'],
  team: ['dedicated_bot', 'broadcasts', 'multi_staff', 'miniapp_staff'],
};

export function hasFeature(plan: Plan, feature: PlanFeature): boolean {
  return FEATURE_MATRIX[plan].includes(feature);
}

export function assertFeature(plan: Plan, feature: PlanFeature): void {
  if (!hasFeature(plan, feature)) throw new PlanFeatureError(feature);
}

/** Monthly booking allowance; `null` means unlimited. */
export function monthlyAppointmentLimit(plan: Plan): number | null {
  return plan === 'free' ? FREE_MONTHLY_APPOINTMENTS : null;
}

export interface MonthlyQuota {
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly exhausted: boolean;
}

export function monthlyQuota(plan: Plan, usedThisMonth: number): MonthlyQuota {
  const limit = monthlyAppointmentLimit(plan);
  if (limit === null)
    return { limit: null, used: usedThisMonth, remaining: null, exhausted: false };
  const remaining = Math.max(0, limit - usedThisMonth);
  return { limit, used: usedThisMonth, remaining, exhausted: remaining === 0 };
}

/**
 * Gate for creating a new appointment. Existing appointments keep working when
 * the quota runs out — only new ones are refused.
 */
export function assertCanCreateAppointment(plan: Plan, usedThisMonth: number): void {
  const quota = monthlyQuota(plan, usedThisMonth);
  if (quota.exhausted && quota.limit !== null) {
    throw new PlanLimitError(quota.limit, quota.used);
  }
}

/** The [start, end) of the calendar month containing `nowMs`, in the tenant's zone. */
export function monthBounds(nowMs: number, timezone: string): { startMs: number; endMs: number } {
  const now = DateTime.fromMillis(nowMs, { zone: timezone });
  const base = now.isValid ? now : DateTime.fromMillis(nowMs, { zone: 'UTC' });
  const start = base.startOf('month');
  return { startMs: start.toMillis(), endMs: start.plus({ months: 1 }).toMillis() };
}
