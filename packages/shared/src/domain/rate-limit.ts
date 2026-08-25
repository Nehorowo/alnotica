/**
 * Per-user action throttling and the cap on how many future appointments one
 * client may hold — a prankster booking out a whole week is a real failure mode.
 */
import { RateLimitedError, TooManyActiveAppointmentsError } from '../errors.js';

export const MAX_ACTIONS_PER_MINUTE = 20;
export const MAX_ACTIVE_APPOINTMENTS_PER_CLIENT = 3;

export interface Bucket {
  /** Timestamps (ms) of the actions still inside the window. */
  hits: number[];
}

/**
 * Fixed-memory sliding window. Lives in-process: with a single VDS there is no
 * second node to share it with, and losing it on restart is harmless.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit = MAX_ACTIONS_PER_MINUTE,
    private readonly windowMs = 60_000,
  ) {}

  /** Records an action; returns false and records nothing when over the limit. */
  tryAcquire(key: string, nowMs: number): boolean {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = nowMs - this.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= this.limit) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.hits.push(nowMs);
    this.buckets.set(key, bucket);
    return true;
  }

  retryAfterSec(key: string, nowMs: number): number {
    const bucket = this.buckets.get(key);
    const oldest = bucket?.hits[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
  }

  assertAcquire(key: string, nowMs: number): void {
    if (!this.tryAcquire(key, nowMs)) {
      throw new RateLimitedError(this.retryAfterSec(key, nowMs));
    }
  }

  /** Drops buckets that have gone quiet, so the map cannot grow without bound. */
  sweep(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((t) => t <= cutoff)) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function assertClientAppointmentCap(
  activeCount: number,
  limit = MAX_ACTIVE_APPOINTMENTS_PER_CLIENT,
): void {
  if (activeCount >= limit) throw new TooManyActiveAppointmentsError(limit);
}
