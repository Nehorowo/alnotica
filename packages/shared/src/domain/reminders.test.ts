import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  appointmentCancelKey,
  askNoShowDedupeKey,
  broadcastCancelKey,
  digestDedupeKey,
  digestTargetDate,
  nextDigestRunAtMs,
  planReminders,
  reminderDedupeKey,
  tenantCancelKey,
} from './reminders.js';

const HOUR = 3_600_000;
const start = Date.UTC(2024, 5, 10, 12, 0);

describe('planReminders', () => {
  it('schedules 24h and 2h reminders for a booking made well in advance', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 72 * HOUR,
      offsetsMin: [1440, 120],
      clientReachable: true,
    });
    expect(plan).toEqual([
      { offsetMin: 1440, runAtMs: start - 24 * HOUR },
      { offsetMin: 120, runAtMs: start - 2 * HOUR },
    ]);
  });

  it('drops a reminder whose moment has already passed', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 3 * HOUR,
      offsetsMin: [1440, 120],
      clientReachable: true,
    });
    expect(plan.map((p) => p.offsetMin)).toEqual([120]);
  });

  it('schedules nothing for a booking made inside the shortest offset', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 30 * 60_000,
      offsetsMin: [1440, 120],
      clientReachable: true,
    });
    expect(plan).toEqual([]);
  });

  it('schedules nothing for a client the bot cannot message', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 72 * HOUR,
      offsetsMin: [1440, 120],
      clientReachable: false,
    });
    expect(plan).toEqual([]);
  });

  it('ignores duplicate, zero and negative offsets', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 72 * HOUR,
      offsetsMin: [1440, 1440, 0, -60, Number.NaN, 120],
      clientReachable: true,
    });
    expect(plan.map((p) => p.offsetMin)).toEqual([1440, 120]);
  });

  it('returns reminders in firing order regardless of input order', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 72 * HOUR,
      offsetsMin: [120, 2880, 1440],
      clientReachable: true,
    });
    expect(plan.map((p) => p.offsetMin)).toEqual([2880, 1440, 120]);
  });

  it('drops a reminder that would fire exactly now', () => {
    const plan = planReminders({
      startsAtMs: start,
      nowMs: start - 2 * HOUR,
      offsetsMin: [120],
      clientReachable: true,
    });
    expect(plan).toEqual([]);
  });
});

describe('cancel and dedupe keys', () => {
  it('namespaces each owner', () => {
    expect(appointmentCancelKey('abc')).toBe('appt:abc');
    expect(tenantCancelKey('abc')).toBe('tenant:abc');
    expect(broadcastCancelKey('abc')).toBe('broadcast:abc');
  });

  it('gives each reminder of an appointment its own dedupe key', () => {
    expect(reminderDedupeKey('a', 1440)).not.toBe(reminderDedupeKey('a', 120));
    expect(reminderDedupeKey('a', 120)).toBe(reminderDedupeKey('a', 120));
    expect(askNoShowDedupeKey('a')).toBe('ask_no_show:a');
    expect(digestDedupeKey('t', '2024-06-10')).toBe('digest:t:2024-06-10');
  });
});

describe('daily digest scheduling', () => {
  it('lands on 20:00 in the tenant zone, today if it has not happened yet', () => {
    const now = DateTime.fromISO('2024-06-10T09:00', { zone: 'Europe/Moscow' }).toMillis();
    const runAt = nextDigestRunAtMs(now, 'Europe/Moscow');
    expect(DateTime.fromMillis(runAt, { zone: 'Europe/Moscow' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2024-06-10 20:00',
    );
  });

  it('rolls over to tomorrow once 20:00 has passed', () => {
    const now = DateTime.fromISO('2024-06-10T20:30', { zone: 'Europe/Moscow' }).toMillis();
    const runAt = nextDigestRunAtMs(now, 'Europe/Moscow');
    expect(DateTime.fromMillis(runAt, { zone: 'Europe/Moscow' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2024-06-11 20:00',
    );
  });

  it('respects the tenant zone rather than the server one', () => {
    const now = DateTime.fromISO('2024-06-10T09:00Z').toMillis();
    const moscow = nextDigestRunAtMs(now, 'Europe/Moscow');
    const nicosia = nextDigestRunAtMs(now, 'Asia/Nicosia');
    const lisbon = nextDigestRunAtMs(now, 'Europe/Lisbon');
    // Moscow and Nicosia are both UTC+3 in June, so they agree; Lisbon does not.
    expect(moscow).toBe(nicosia);
    expect(lisbon - moscow).toBe(2 * HOUR); // UTC+1 vs UTC+3 in June
    for (const [zone, at] of [
      ['Europe/Moscow', moscow],
      ['Europe/Lisbon', lisbon],
    ] as const) {
      expect(DateTime.fromMillis(at, { zone }).toFormat('HH:mm')).toBe('20:00');
    }
  });

  it('falls back to a day later for an unknown zone instead of throwing', () => {
    const now = Date.UTC(2024, 5, 10, 9, 0);
    expect(nextDigestRunAtMs(now, 'Nowhere/Nothing')).toBe(now + 24 * HOUR);
  });

  it('covers the day after it is sent', () => {
    const runAt = DateTime.fromISO('2024-06-10T20:00', { zone: 'Europe/Moscow' }).toMillis();
    expect(digestTargetDate(runAt, 'Europe/Moscow')).toBe('2024-06-11');
  });
});
