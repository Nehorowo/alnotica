/**
 * Broadcast rules. A shared bot banned for spam takes every tenant down with it,
 * so these limits are not advisory — they are the thing standing between us and
 * a dead product.
 */
import { BroadcastLimitError } from '../errors.js';

export const MAX_BROADCASTS_PER_MONTH = 4;
export const MIN_HOURS_BETWEEN_BROADCASTS = 48;
export const MIN_TENANT_AGE_DAYS = 7;
/** The first N broadcasts of every tenant go through a human. */
export const MODERATED_BROADCAST_COUNT = 3;
/** Slow lane: mass sends never contend with transactional messages. */
export const BROADCAST_RATE_PER_SEC = 20;
export const BROADCAST_CHUNK_SIZE = 100;

/** "A window opened" — offer a freed slot to clients who have not visited in a while. */
export const WINDOW_OPENED_INACTIVE_DAYS = 45;

export interface BroadcastGateInput {
  readonly nowMs: number;
  readonly tenantCreatedAtMs: number;
  /** Broadcasts already sent (or sending) in the current calendar month. */
  readonly sentThisMonth: number;
  /** Timestamp of the most recent broadcast, if any. */
  readonly lastBroadcastAtMs: number | null;
  readonly audienceSize: number;
}

export type BroadcastRejection =
  | 'monthly_quota'
  | 'cooldown'
  | 'tenant_too_young'
  | 'empty_audience';

/** Returns the reason a broadcast may not be sent, or `null` when it may. */
export function broadcastRejection(input: BroadcastGateInput): BroadcastRejection | null {
  const ageDays = (input.nowMs - input.tenantCreatedAtMs) / 86_400_000;
  if (ageDays < MIN_TENANT_AGE_DAYS) return 'tenant_too_young';
  if (input.sentThisMonth >= MAX_BROADCASTS_PER_MONTH) return 'monthly_quota';
  if (input.lastBroadcastAtMs !== null) {
    const hoursSince = (input.nowMs - input.lastBroadcastAtMs) / 3_600_000;
    if (hoursSince < MIN_HOURS_BETWEEN_BROADCASTS) return 'cooldown';
  }
  if (input.audienceSize <= 0) return 'empty_audience';
  return null;
}

export function assertBroadcastAllowed(input: BroadcastGateInput): void {
  const reason = broadcastRejection(input);
  if (reason) throw new BroadcastLimitError(reason);
}

/** Whether this broadcast needs a human to approve it before it goes out. */
export function needsModeration(broadcastsEverSent: number): boolean {
  return broadcastsEverSent < MODERATED_BROADCAST_COUNT;
}

/* --------------------------------- audience -------------------------------- */

export type AudienceFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'visited_within'; readonly days: number }
  | { readonly kind: 'not_visited_for'; readonly days: number }
  | { readonly kind: 'used_service'; readonly serviceId: string };

/**
 * Only these filters exist. Uploading one's own list of chat ids is impossible by
 * construction — we never accept an audience we did not compute ourselves.
 */
export const AUDIENCE_KINDS = ['all', 'visited_within', 'not_visited_for', 'used_service'] as const;

export function chunk<T>(items: readonly T[], size = BROADCAST_CHUNK_SIZE): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Delay between chunks so the slow lane stays under the per-second ceiling. */
export function chunkDelayMs(
  chunkSize = BROADCAST_CHUNK_SIZE,
  ratePerSec = BROADCAST_RATE_PER_SEC,
): number {
  return Math.ceil((chunkSize / ratePerSec) * 1000);
}
