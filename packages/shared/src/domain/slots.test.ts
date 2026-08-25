import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type {
  BusyInterval,
  ServiceDuration,
  SlotQuery,
  SlotRules,
  WorkingInterval,
} from './slots.js';
import {
  formatLocalTime,
  isSlotBookable,
  mergeBusy,
  nextSlots,
  occupiedSpan,
  parseLocalTime,
  resolveLocal,
  slotsForDay,
  slotsForRange,
  toInterval,
  workingSpansForDay,
} from './slots.js';

const MSK = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

function rules(over: Partial<SlotRules> = {}): SlotRules {
  return {
    timezone: MSK,
    slotStepMin: 30,
    minLeadTimeMin: 120,
    bookingHorizonDays: 30,
    ...over,
  };
}

const service = (over: Partial<ServiceDuration> = {}): ServiceDuration => ({
  durationMin: 60,
  bufferAfterMin: 0,
  ...over,
});

/** Mon–Fri 09:00–18:00 in the tenant's zone. */
function weekdays(startsLocal = '09:00', endsLocal = '18:00'): WorkingInterval[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    weekday: weekday as WorkingInterval['weekday'],
    startsLocal,
    endsLocal,
  }));
}

function at(iso: string, zone = MSK): number {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad fixture time ${iso}: ${dt.invalidReason}`);
  return dt.toMillis();
}

function query(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    date: '2024-06-05', // Wednesday
    rules: rules(),
    service: service(),
    workingHours: weekdays(),
    busy: [],
    nowMs: at('2024-06-05T00:00'),
    ...over,
  };
}

const labels = (q: SlotQuery) => slotsForDay(q).map((s) => s.localTime);

describe('parseLocalTime / formatLocalTime', () => {
  it('parses HH:mm and HH:mm:ss', () => {
    expect(parseLocalTime('09:00')).toBe(540);
    expect(parseLocalTime('9:05')).toBe(545);
    expect(parseLocalTime('18:30:00')).toBe(1110);
    expect(parseLocalTime('24:00')).toBe(1440);
  });

  it('rejects nonsense', () => {
    expect(() => parseLocalTime('25:00')).toThrow(RangeError);
    expect(() => parseLocalTime('12:60')).toThrow(RangeError);
    expect(() => parseLocalTime('noon')).toThrow(RangeError);
  });

  it('round-trips through formatLocalTime', () => {
    expect(formatLocalTime(parseLocalTime('07:45'))).toBe('07:45');
    expect(formatLocalTime(0)).toBe('00:00');
  });
});

describe('mergeBusy', () => {
  it('merges overlapping and touching spans, drops empty ones', () => {
    const merged = mergeBusy([
      { startsAtMs: 30, endsAtMs: 40 },
      { startsAtMs: 0, endsAtMs: 10 },
      { startsAtMs: 5, endsAtMs: 20 },
      { startsAtMs: 20, endsAtMs: 25 },
      { startsAtMs: 99, endsAtMs: 99 },
    ]);
    expect(merged).toEqual([
      { startsAtMs: 0, endsAtMs: 25 },
      { startsAtMs: 30, endsAtMs: 40 },
    ]);
  });

  it('keeps a span fully contained in another from truncating it', () => {
    expect(
      mergeBusy([
        { startsAtMs: 0, endsAtMs: 100 },
        { startsAtMs: 10, endsAtMs: 20 },
      ]),
    ).toEqual([{ startsAtMs: 0, endsAtMs: 100 }]);
  });
});

describe('resolveLocal', () => {
  it('resolves an ordinary wall clock', () => {
    const r = resolveLocal('2024-06-05', 540, MSK);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.dt.toISO()).toBe('2024-06-05T09:00:00.000+03:00');
  });

  it('reports a time swallowed by a spring-forward gap as shifted', () => {
    // Berlin 2024-03-31: 02:00 CET jumps straight to 03:00 CEST.
    const r = resolveLocal('2024-03-31', 150, BERLIN); // 02:30
    expect(r.kind).toBe('shifted');
    if (r.kind !== 'shifted') throw new Error('unreachable');
    expect(r.dt.hour).toBe(3);
  });

  it('picks the first offset for an ambiguous fall-back time', () => {
    // Berlin 2024-10-27: 02:30 happens twice; the pre-transition one is CEST (+02:00).
    const r = resolveLocal('2024-10-27', 150, BERLIN);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.dt.offset).toBe(120);
  });

  it('treats 24:00 as midnight of the following day', () => {
    const r = resolveLocal('2024-06-05', 1440, MSK);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.dt.toFormat('yyyy-MM-dd HH:mm')).toBe('2024-06-06 00:00');
  });

  it('rejects a malformed date or unknown zone', () => {
    expect(resolveLocal('05.06.2024', 540, MSK).kind).toBe('invalid');
    expect(resolveLocal('2024-06-05', 540, 'Mars/Olympus').kind).toBe('invalid');
  });
});

describe('workingSpansForDay', () => {
  it('returns nothing on a day the master does not work', () => {
    expect(workingSpansForDay('2024-06-09', MSK, weekdays())).toEqual([]); // Sunday
  });

  it('maps weekday 0 to Sunday', () => {
    const sunday: WorkingInterval[] = [{ weekday: 0, startsLocal: '10:00', endsLocal: '14:00' }];
    const spans = workingSpansForDay('2024-06-09', MSK, sunday);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.startMs).toBe(at('2024-06-09T10:00'));
  });

  it('ignores an interval that ends before it starts', () => {
    const broken: WorkingInterval[] = [{ weekday: 3, startsLocal: '18:00', endsLocal: '09:00' }];
    expect(workingSpansForDay('2024-06-05', MSK, broken)).toEqual([]);
  });
});

describe('slotsForDay — ordinary day', () => {
  it('produces a full grid inside working hours', () => {
    const q = query({ nowMs: at('2024-06-04T12:00') });
    // 09:00–18:00, 60 min service, 30 min step: last start that fits is 17:00.
    expect(labels(q)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '17:00',
    ]);
  });

  it('reports both UTC instants and local labels', () => {
    const first = slotsForDay(query({ nowMs: at('2024-06-04T12:00') }))[0];
    expect(first?.startsAtMs).toBe(at('2024-06-05T09:00'));
    expect(first?.endsAtMs).toBe(at('2024-06-05T10:00'));
    expect(first?.localDate).toBe('2024-06-05');
    expect(first?.ambiguous).toBe(false);
  });

  it('counts the buffer as occupied time but not as service time', () => {
    const q = query({ nowMs: at('2024-06-04T12:00'), service: service({ bufferAfterMin: 15 }) });
    const slots = slotsForDay(q);
    expect(slots[0]?.serviceEndsAtMs).toBe(at('2024-06-05T10:00'));
    expect(slots[0]?.endsAtMs).toBe(at('2024-06-05T10:15'));
    // 75 minutes must fit before 18:00, so 16:30 is the last viable start.
    expect(slots.at(-1)?.localTime).toBe('16:30');
  });

  it('returns nothing when the schedule is empty', () => {
    expect(slotsForDay(query({ workingHours: [] }))).toEqual([]);
  });

  it('returns nothing on a day off', () => {
    expect(slotsForDay(query({ date: '2024-06-08' }))).toEqual([]); // Saturday
  });
});

describe('slotsForDay — lunch break', () => {
  it('treats two intervals on one weekday as a break between them', () => {
    const withLunch: WorkingInterval[] = [
      { weekday: 3, startsLocal: '09:00', endsLocal: '13:00' },
      { weekday: 3, startsLocal: '14:00', endsLocal: '18:00' },
    ];
    const q = query({ workingHours: withLunch, nowMs: at('2024-06-04T12:00') });
    expect(labels(q)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '17:00',
    ]);
  });
});

describe('slotsForDay — service does not fit', () => {
  it('drops starts whose occupied span crosses the end of the working stretch', () => {
    const q = query({
      nowMs: at('2024-06-04T12:00'),
      workingHours: [{ weekday: 3, startsLocal: '09:00', endsLocal: '11:00' }],
      service: service({ durationMin: 90 }),
    });
    expect(labels(q)).toEqual(['09:00', '09:30']);
  });

  it('returns nothing when the service is longer than the whole day', () => {
    const q = query({
      nowMs: at('2024-06-04T12:00'),
      service: service({ durationMin: 10 * 60 }),
    });
    expect(slotsForDay(q)).toEqual([]);
  });
});

describe('slotsForDay — existing appointments', () => {
  it('removes every start whose span overlaps a busy interval', () => {
    const busy: BusyInterval[] = [
      { startsAtMs: at('2024-06-05T12:00'), endsAtMs: at('2024-06-05T13:00') },
    ];
    const q = query({ nowMs: at('2024-06-04T12:00'), busy });
    const got = labels(q);
    expect(got).not.toContain('12:00');
    expect(got).not.toContain('11:30'); // 11:30–12:30 overlaps
    expect(got).toContain('11:00'); // 11:00–12:00 touches the boundary, which is fine
    expect(got).toContain('13:00');
  });

  it('lets a half-day time off close the afternoon', () => {
    const busy: BusyInterval[] = [
      { startsAtMs: at('2024-06-05T15:00'), endsAtMs: at('2024-06-06T00:00') },
    ];
    const q = query({ nowMs: at('2024-06-04T12:00'), busy });
    expect(labels(q).at(-1)).toBe('14:00');
  });

  it('lets a multi-day vacation close the day entirely', () => {
    const busy: BusyInterval[] = [
      { startsAtMs: at('2024-06-03T00:00'), endsAtMs: at('2024-06-10T00:00') },
    ];
    expect(slotsForDay(query({ nowMs: at('2024-06-01T12:00'), busy }))).toEqual([]);
  });
});

describe('slotsForDay — minimum lead time', () => {
  it('excludes a start exactly at the lead-time boundary only when it is earlier', () => {
    // now 09:59 + 120 min lead => earliest 11:59, so 11:30 is out and 12:00 is in.
    const q = query({ nowMs: at('2024-06-05T09:59') });
    const got = labels(q);
    expect(got).not.toContain('11:30');
    expect(got[0]).toBe('12:00');
  });

  it('keeps a start that lands exactly on the boundary', () => {
    const q = query({ nowMs: at('2024-06-05T10:00') }); // earliest = 12:00 exactly
    expect(labels(q)[0]).toBe('12:00');
  });

  it('empties a day that has already passed', () => {
    expect(slotsForDay(query({ nowMs: at('2024-06-05T23:00') }))).toEqual([]);
  });

  it('honours a zero lead time', () => {
    const q = query({ nowMs: at('2024-06-05T10:00'), rules: rules({ minLeadTimeMin: 0 }) });
    expect(labels(q)[0]).toBe('10:00');
  });
});

describe('slotsForDay — booking horizon', () => {
  it('does not offer slots past the horizon', () => {
    const q = query({
      date: '2024-07-10',
      nowMs: at('2024-06-05T10:00'),
      rules: rules({ bookingHorizonDays: 7 }),
    });
    expect(slotsForDay(q)).toEqual([]);
  });

  it('offers slots on the last day inside the horizon', () => {
    const q = query({
      date: '2024-06-12',
      nowMs: at('2024-06-05T10:00'),
      rules: rules({ bookingHorizonDays: 7 }),
    });
    expect(slotsForDay(q).length).toBeGreaterThan(0);
  });
});

describe('slotsForDay — DST', () => {
  it('spring forward: no slot lands inside the missing hour and none is duplicated', () => {
    // Berlin 2024-03-31 is 23 hours long: 02:00 CET -> 03:00 CEST.
    const q: SlotQuery = {
      date: '2024-03-31',
      rules: rules({ timezone: BERLIN, minLeadTimeMin: 0 }),
      service: service({ durationMin: 30 }),
      workingHours: [{ weekday: 0, startsLocal: '01:00', endsLocal: '05:00' }],
      busy: [],
      nowMs: at('2024-03-30T00:00', BERLIN),
    };
    const slots = slotsForDay(q);
    // 01:00 -> 05:00 wall clock is only three real hours on this day.
    expect(slots.map((s) => s.localTime)).toEqual([
      '01:00',
      '01:30',
      '03:00',
      '03:30',
      '04:00',
      '04:30',
    ]);
    expect(new Set(slots.map((s) => s.startsAtMs)).size).toBe(slots.length);
    for (const s of slots) {
      const hour = DateTime.fromMillis(s.startsAtMs, { zone: BERLIN }).hour;
      expect(hour).not.toBe(2); // the hour that does not exist
    }
    // Consecutive starts are always exactly one step of real time apart.
    for (let i = 1; i < slots.length; i++) {
      expect((slots[i]?.startsAtMs ?? 0) - (slots[i - 1]?.startsAtMs ?? 0)).toBe(30 * 60_000);
    }
  });

  it('fall back: the repeated hour yields distinct instants, flagged as ambiguous', () => {
    // Berlin 2024-10-27 is 25 hours long: 03:00 CEST -> 02:00 CET.
    const q: SlotQuery = {
      date: '2024-10-27',
      rules: rules({ timezone: BERLIN, minLeadTimeMin: 0 }),
      service: service({ durationMin: 30 }),
      workingHours: [{ weekday: 0, startsLocal: '01:00', endsLocal: '05:00' }],
      busy: [],
      nowMs: at('2024-10-26T00:00', BERLIN),
    };
    const slots = slotsForDay(q);
    // Five real hours of wall clock => ten half-hour slots.
    expect(slots).toHaveLength(10);
    expect(new Set(slots.map((s) => s.startsAtMs)).size).toBe(10);
    const twos = slots.filter((s) => s.localTime === '02:00');
    expect(twos).toHaveLength(2);
    expect(twos.every((s) => s.ambiguous)).toBe(true);
    expect(slots.filter((s) => s.localTime === '01:00').every((s) => !s.ambiguous)).toBe(true);
  });

  it('a working stretch starting inside the gap rolls forward instead of vanishing', () => {
    const q: SlotQuery = {
      date: '2024-03-31',
      rules: rules({ timezone: BERLIN, minLeadTimeMin: 0 }),
      service: service({ durationMin: 30 }),
      workingHours: [{ weekday: 0, startsLocal: '02:30', endsLocal: '05:00' }],
      busy: [],
      nowMs: at('2024-03-30T00:00', BERLIN),
    };
    // 02:30 CET does not exist; it becomes 03:30 CEST, one gap-length later.
    expect(slotsForDay(q).map((s) => s.localTime)).toEqual(['03:30', '04:00', '04:30']);
  });

  it('a day whose local midnight does not exist still produces slots', () => {
    // America/Santiago 2024-09-08: the clock jumps 00:00 -> 01:00.
    const q: SlotQuery = {
      date: '2024-09-08',
      rules: rules({ timezone: 'America/Santiago', minLeadTimeMin: 0 }),
      service: service({ durationMin: 60 }),
      workingHours: [{ weekday: 0, startsLocal: '09:00', endsLocal: '13:00' }],
      busy: [],
      nowMs: at('2024-09-07T00:00', 'America/Santiago'),
    };
    expect(slotsForDay(q).map((s) => s.localTime)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
    ]);
  });
});

describe('slotsForDay — guards', () => {
  it('rejects a non-positive step or duration', () => {
    expect(() => slotsForDay(query({ rules: rules({ slotStepMin: 0 }) }))).toThrow(RangeError);
    expect(() => slotsForDay(query({ service: service({ durationMin: 0 }) }))).toThrow(RangeError);
  });

  it('returns nothing for an unparseable date', () => {
    expect(slotsForDay(query({ date: 'yesterday' }))).toEqual([]);
  });

  it('does not emit the same instant twice for overlapping working stretches', () => {
    const overlapping: WorkingInterval[] = [
      { weekday: 3, startsLocal: '09:00', endsLocal: '12:00' },
      { weekday: 3, startsLocal: '10:00', endsLocal: '13:00' },
    ];
    const slots = slotsForDay(query({ workingHours: overlapping, nowMs: at('2024-06-04T12:00') }));
    expect(new Set(slots.map((s) => s.startsAtMs)).size).toBe(slots.length);
  });
});

describe('slotsForRange', () => {
  it('walks every local day inclusively', () => {
    const days = slotsForRange({
      ...query({ nowMs: at('2024-06-03T00:00') }),
      from: '2024-06-03',
      to: '2024-06-09',
    });
    expect(days.map((d) => d.date)).toEqual([
      '2024-06-03',
      '2024-06-04',
      '2024-06-05',
      '2024-06-06',
      '2024-06-07',
      '2024-06-08',
      '2024-06-09',
    ]);
    expect(days.at(-1)?.slots).toEqual([]); // Sunday
  });

  it('returns nothing for a reversed or malformed range', () => {
    const base = query();
    expect(slotsForRange({ ...base, from: '2024-06-09', to: '2024-06-03' })).toEqual([]);
    expect(slotsForRange({ ...base, from: 'nope', to: '2024-06-03' })).toEqual([]);
  });
});

describe('isSlotBookable', () => {
  it('accepts a start on the grid and rejects one off it', () => {
    const q = query({ nowMs: at('2024-06-04T12:00') });
    expect(isSlotBookable(q, at('2024-06-05T10:00'))).toBe(true);
    expect(isSlotBookable(q, at('2024-06-05T10:07'))).toBe(false);
    expect(isSlotBookable(q, at('2024-06-05T08:00'))).toBe(false);
  });

  it('rejects a start that a concurrent booking has just occupied', () => {
    const busy: BusyInterval[] = [
      { startsAtMs: at('2024-06-05T10:00'), endsAtMs: at('2024-06-05T11:00') },
    ];
    const q = query({ nowMs: at('2024-06-04T12:00'), busy });
    expect(isSlotBookable(q, at('2024-06-05T10:00'))).toBe(false);
  });
});

describe('nextSlots', () => {
  it('collects the first N free slots across days', () => {
    const base = query({ nowMs: at('2024-06-07T17:00') }); // Friday evening
    const got = nextSlots({ ...base, fromDate: '2024-06-07' }, 8);
    expect(got).toHaveLength(8);
    // Friday is over and the weekend is closed, so everything lands on Monday.
    expect(got.every((s) => s.localDate === '2024-06-10')).toBe(true);
    expect(got[0]?.localTime).toBe('09:00');
  });

  it('stops at the horizon instead of looping forever', () => {
    const base = query({ workingHours: [], nowMs: at('2024-06-07T17:00') });
    expect(nextSlots({ ...base, fromDate: '2024-06-07' }, 8)).toEqual([]);
  });

  it('returns nothing for a malformed start date', () => {
    expect(nextSlots({ ...query(), fromDate: 'soon' }, 3)).toEqual([]);
  });
});

describe('occupiedSpan / toInterval', () => {
  it('materializes duration plus buffer', () => {
    const span = occupiedSpan(at('2024-06-05T10:00'), { durationMin: 45, bufferAfterMin: 15 });
    expect(span.endsAtMs).toBe(at('2024-06-05T11:00'));
  });

  it('exposes a Luxon interval in the tenant zone', () => {
    const iv = toInterval(occupiedSpan(at('2024-06-05T10:00'), service()), MSK);
    expect(iv.start?.hour).toBe(10);
    expect(iv.end?.hour).toBe(11);
  });
});
