import { describe, expect, it } from 'vitest';
import {
  BroadcastLimitError,
  PlanFeatureError,
  PlanLimitError,
  RateLimitedError,
  TooManyActiveAppointmentsError,
  isDomainError,
} from '../errors.js';
import {
  assertBroadcastAllowed,
  broadcastRejection,
  chunk,
  chunkDelayMs,
  needsModeration,
} from './broadcast.js';
import { noCalendarSync } from './calendar-sync.js';
import {
  assertCanCreateAppointment,
  assertFeature,
  hasFeature,
  monthBounds,
  monthlyAppointmentLimit,
  monthlyQuota,
  yearlyPriceMinor,
} from './plan.js';
import { SlidingWindowLimiter, assertClientAppointmentCap } from './rate-limit.js';
import {
  type StatsRow,
  averageTicketMinor,
  computeStats,
  estimatedSavedMinor,
  formatPercent,
} from './stats.js';

const DAY = 86_400_000;
const now = Date.UTC(2024, 5, 10, 12, 0);

describe('broadcast gate', () => {
  const base = {
    nowMs: now,
    tenantCreatedAtMs: now - 30 * DAY,
    sentThisMonth: 0,
    lastBroadcastAtMs: null,
    audienceSize: 50,
  };

  it('lets a healthy tenant through', () => {
    expect(broadcastRejection(base)).toBeNull();
  });

  it('rejects the fifth broadcast of the month', () => {
    expect(broadcastRejection({ ...base, sentThisMonth: 4 })).toBe('monthly_quota');
    expect(broadcastRejection({ ...base, sentThisMonth: 3 })).toBeNull();
  });

  it('rejects a second broadcast inside 48 hours', () => {
    expect(broadcastRejection({ ...base, lastBroadcastAtMs: now - 24 * 3_600_000 })).toBe(
      'cooldown',
    );
    expect(broadcastRejection({ ...base, lastBroadcastAtMs: now - 49 * 3_600_000 })).toBeNull();
  });

  it('rejects a tenant younger than a week', () => {
    expect(broadcastRejection({ ...base, tenantCreatedAtMs: now - 6 * DAY })).toBe(
      'tenant_too_young',
    );
    expect(broadcastRejection({ ...base, tenantCreatedAtMs: now - 7 * DAY })).toBeNull();
  });

  it('rejects an empty audience', () => {
    expect(broadcastRejection({ ...base, audienceSize: 0 })).toBe('empty_audience');
  });

  it('checks age before quota, so the message is the most useful one', () => {
    const young = { ...base, tenantCreatedAtMs: now - DAY, sentThisMonth: 9 };
    expect(broadcastRejection(young)).toBe('tenant_too_young');
  });

  it('throws a typed error from the assert form', () => {
    expect(() => assertBroadcastAllowed({ ...base, sentThisMonth: 4 })).toThrow(
      BroadcastLimitError,
    );
    expect(() => assertBroadcastAllowed(base)).not.toThrow();
  });

  it('moderates the first three sends only', () => {
    expect(needsModeration(0)).toBe(true);
    expect(needsModeration(2)).toBe(true);
    expect(needsModeration(3)).toBe(false);
  });
});

describe('chunking', () => {
  it('splits into fixed-size chunks with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it('spaces chunks to stay under the slow-lane rate', () => {
    expect(chunkDelayMs(100, 20)).toBe(5000);
  });
});

describe('plans', () => {
  it('caps the free tier at 30 confirmed bookings a month', () => {
    expect(monthlyAppointmentLimit('free')).toBe(30);
    expect(monthlyAppointmentLimit('pro')).toBeNull();
    expect(monthlyQuota('free', 28)).toEqual({
      limit: 30,
      used: 28,
      remaining: 2,
      exhausted: false,
    });
    expect(monthlyQuota('free', 30).exhausted).toBe(true);
    expect(monthlyQuota('free', 45).remaining).toBe(0);
    expect(monthlyQuota('pro', 999).exhausted).toBe(false);
  });

  it('refuses new bookings once the free quota is spent', () => {
    expect(() => assertCanCreateAppointment('free', 30)).toThrow(PlanLimitError);
    expect(() => assertCanCreateAppointment('free', 29)).not.toThrow();
    expect(() => assertCanCreateAppointment('team', 1000)).not.toThrow();
  });

  it('gates features by plan', () => {
    expect(hasFeature('free', 'broadcasts')).toBe(false);
    expect(hasFeature('pro', 'broadcasts')).toBe(true);
    expect(hasFeature('pro', 'multi_staff')).toBe(false);
    expect(hasFeature('team', 'multi_staff')).toBe(true);
    expect(() => assertFeature('free', 'dedicated_bot')).toThrow(PlanFeatureError);
  });

  it('discounts the yearly price by a fifth', () => {
    expect(yearlyPriceMinor('pro')).toBe(Math.round(99_000 * 12 * 0.8));
    expect(yearlyPriceMinor('free')).toBe(0);
  });

  it('bounds the calendar month in the tenant zone', () => {
    const { startMs, endMs } = monthBounds(now, 'Europe/Moscow');
    expect(new Date(startMs).toISOString()).toBe('2024-05-31T21:00:00.000Z');
    expect(endMs - startMs).toBe(30 * DAY);
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(monthBounds(now, 'Nowhere/Nothing').startMs).toBe(Date.UTC(2024, 5, 1));
  });
});

describe('rate limiting', () => {
  it('allows the first N actions and blocks the next one', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    expect(limiter.tryAcquire('u1', 0)).toBe(true);
    expect(limiter.tryAcquire('u1', 1)).toBe(true);
    expect(limiter.tryAcquire('u1', 2)).toBe(true);
    expect(limiter.tryAcquire('u1', 3)).toBe(false);
    expect(limiter.tryAcquire('u2', 3)).toBe(true);
  });

  it('lets the window slide', () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    limiter.tryAcquire('u', 0);
    limiter.tryAcquire('u', 100);
    expect(limiter.tryAcquire('u', 200)).toBe(false);
    expect(limiter.tryAcquire('u', 1101)).toBe(true);
  });

  it('reports when the caller may try again', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    limiter.tryAcquire('u', 0);
    expect(limiter.retryAfterSec('u', 0)).toBe(60);
    expect(limiter.retryAfterSec('unknown', 0)).toBe(0);
  });

  it('throws a typed error from the assert form', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    limiter.assertAcquire('u', 0);
    expect(() => limiter.assertAcquire('u', 1)).toThrow(RateLimitedError);
  });

  it('sweeps idle buckets so memory does not grow forever', () => {
    const limiter = new SlidingWindowLimiter(5, 1000);
    limiter.tryAcquire('a', 0);
    limiter.tryAcquire('b', 5000);
    expect(limiter.size).toBe(2);
    limiter.sweep(5001);
    expect(limiter.size).toBe(1);
  });

  it('caps how many future appointments one client may hold', () => {
    expect(() => assertClientAppointmentCap(2)).not.toThrow();
    expect(() => assertClientAppointmentCap(3)).toThrow(TooManyActiveAppointmentsError);
  });
});

describe('statistics', () => {
  const row = (over: Partial<StatsRow> = {}): StatsRow => ({
    status: 'completed',
    priceMinor: 300_000,
    serviceId: 's1',
    serviceName: 'Стрижка',
    clientId: 'c1',
    isFirstVisit: false,
    ...over,
  });

  it('computes the no-show rate over decided visits only', () => {
    const stats = computeStats(
      [
        row({ clientId: 'c1' }),
        row({ clientId: 'c2' }),
        row({ status: 'no_show', clientId: 'c3', priceMinor: 300_000 }),
        row({ status: 'cancelled_by_client', clientId: 'c4' }),
      ],
      { remindersSent: 10, remindersConfirmed: 6 },
    );
    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(2);
    expect(stats.noShow).toBe(1);
    expect(stats.cancelled).toBe(1);
    // 1 no-show out of 3 decided visits — cancellations are not in the denominator.
    expect(stats.noShowRate).toBeCloseTo(1 / 3);
    expect(stats.revenueMinor).toBe(600_000); // no-shows earn nothing
    expect(stats.remindersSent).toBe(10);
    expect(stats.remindersConfirmed).toBe(6);
  });

  it('reports zero rather than NaN when nothing has been decided', () => {
    expect(computeStats([], { remindersSent: 0, remindersConfirmed: 0 }).noShowRate).toBe(0);
  });

  it('separates new clients from returning ones', () => {
    const stats = computeStats(
      [
        row({ clientId: 'c1', isFirstVisit: true }),
        row({ clientId: 'c1' }),
        row({ clientId: 'c2' }),
      ],
      { remindersSent: 0, remindersConfirmed: 0 },
    );
    expect(stats.newClients).toBe(1);
    expect(stats.returningClients).toBe(1);
  });

  it('ranks the busiest services first, capped at five', () => {
    const rows = [
      row({ serviceId: 'a', serviceName: 'A' }),
      row({ serviceId: 'b', serviceName: 'B' }),
      row({ serviceId: 'b', serviceName: 'B' }),
    ];
    const top = computeStats(rows, { remindersSent: 0, remindersConfirmed: 0 }).topServices;
    expect(top[0]).toEqual({ serviceId: 'b', serviceName: 'B', count: 2 });
    expect(top).toHaveLength(2);
  });

  it('counts expired bookings as cancellations and ignores open ones', () => {
    const stats = computeStats(
      [row({ status: 'expired' }), row({ status: 'confirmed' }), row({ status: 'rescheduled' })],
      { remindersSent: 0, remindersConfirmed: 0 },
    );
    expect(stats.cancelled).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('estimates the money reminders saved against a 20% baseline', () => {
    const stats = computeStats(
      Array.from({ length: 100 }, (_, i) =>
        row({ clientId: `c${i}`, status: i < 8 ? 'no_show' : 'completed' }),
      ),
      { remindersSent: 100, remindersConfirmed: 70 },
    );
    expect(stats.noShow).toBe(8);
    expect(averageTicketMinor(stats)).toBe(300_000);
    // 20 expected no-shows minus 8 actual = 12 visits saved.
    expect(estimatedSavedMinor(stats, 300_000)).toBe(12 * 300_000);
  });

  it('never reports negative savings for a tenant doing worse than baseline', () => {
    const stats = computeStats(
      Array.from({ length: 10 }, (_, i) => row({ clientId: `c${i}`, status: 'no_show' })),
      { remindersSent: 0, remindersConfirmed: 0 },
    );
    expect(estimatedSavedMinor(stats, 300_000)).toBe(0);
    expect(averageTicketMinor(stats)).toBe(0);
  });

  it('formats a percentage without a trailing .0', () => {
    expect(formatPercent(0.075)).toBe('7.5%');
    expect(formatPercent(0.2)).toBe('20%');
  });
});

describe('calendar sync placeholder', () => {
  it('is a no-op that satisfies the interface', async () => {
    expect(noCalendarSync.provider).toBe('none');
    expect(await noCalendarSync.pullBusy('s', 0, 1)).toEqual([]);
    expect(
      await noCalendarSync.push('s', { externalId: 'x', startsAtMs: 0, endsAtMs: 1, title: 't' }),
    ).toBe('x');
    await expect(noCalendarSync.remove('s', 'x')).resolves.toBeUndefined();
  });
});

describe('error taxonomy', () => {
  it('marks domain errors as safe to show a user', () => {
    expect(isDomainError(new PlanLimitError(30, 30))).toBe(true);
    expect(isDomainError(new Error('boom'))).toBe(false);
    expect(new RateLimitedError(5).retryAfterSec).toBe(5);
  });
});
