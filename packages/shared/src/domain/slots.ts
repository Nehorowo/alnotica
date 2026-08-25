/**
 * Slot generation. Pure, no I/O, no Node built-ins — this module is bundled into
 * the Mini App and runs unchanged in the browser, so the availability preview the
 * client sees is computed by the exact code that validates the booking on the
 * server. The server always remains the source of truth.
 *
 * Everything crossing the boundary is an epoch-millisecond number (UTC). Local
 * wall-clock arithmetic is done exclusively through Luxon with an explicit IANA
 * zone; `Date` is never used for it, because `new Date(y, m, d, h)` silently
 * depends on the server's TZ.
 */
import { DateTime, Interval } from 'luxon';
import type { Weekday } from '../types/index.js';

/* ---------------------------------- input --------------------------------- */

/** One continuous working stretch on a given weekday, in the tenant's local time. */
export interface WorkingInterval {
  readonly weekday: Weekday;
  /** 'HH:mm' or 'HH:mm:ss' local. */
  readonly startsLocal: string;
  /** 'HH:mm' or 'HH:mm:ss' local. '24:00' means "until midnight". */
  readonly endsLocal: string;
}

/** A half-open [start, end) span of real time that cannot be booked over. */
export interface BusyInterval {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export interface SlotRules {
  /** IANA zone of the tenant, e.g. 'Europe/Moscow'. */
  readonly timezone: string;
  /** Grid step in minutes (15 or 30 typically). */
  readonly slotStepMin: number;
  /** How far ahead of `nowMs` the earliest bookable slot may be. */
  readonly minLeadTimeMin: number;
  /** How many days ahead the calendar is open. */
  readonly bookingHorizonDays: number;
}

export interface ServiceDuration {
  readonly durationMin: number;
  /** Cleanup/turnaround time reserved after the service; part of the occupied span. */
  readonly bufferAfterMin: number;
}

export interface SlotQuery {
  /** Local calendar day, 'yyyy-MM-dd' in the tenant's zone. */
  readonly date: string;
  readonly rules: SlotRules;
  readonly service: ServiceDuration;
  readonly workingHours: readonly WorkingInterval[];
  /** Existing appointments and time off, already in UTC epoch ms. */
  readonly busy: readonly BusyInterval[];
  readonly nowMs: number;
}

/* --------------------------------- output --------------------------------- */

export interface Slot {
  /** Start of the service, UTC epoch ms. */
  readonly startsAtMs: number;
  /** End of the occupied span: start + duration + buffer, UTC epoch ms. */
  readonly endsAtMs: number;
  /** End of the service itself (what the client is told), UTC epoch ms. */
  readonly serviceEndsAtMs: number;
  /** 'HH:mm' in the tenant's zone — what the user sees. */
  readonly localTime: string;
  /** 'yyyy-MM-dd' in the tenant's zone. */
  readonly localDate: string;
  /**
   * True when this wall-clock reading occurs twice on this day (the repeated hour
   * of a fall-back transition). Both slots are real and bookable; the UI needs to
   * distinguish them, e.g. by appending the UTC offset.
   */
  readonly ambiguous: boolean;
}

export interface DayAvailability {
  readonly date: string;
  readonly slots: readonly Slot[];
}

/* -------------------------------- internals ------------------------------- */

const HHMM = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Minutes since local midnight. Accepts '24:00' as the end of the day. */
export function parseLocalTime(value: string): number {
  const m = HHMM.exec(value.trim());
  if (!m) throw new RangeError(`invalid local time: ${value}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] === undefined ? 0 : Number(m[3]);
  if (hours > 24 || minutes > 59 || seconds > 59)
    throw new RangeError(`invalid local time: ${value}`);
  const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
  if (total > 24 * 60) throw new RangeError(`invalid local time: ${value}`);
  return total;
}

export function formatLocalTime(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * How a requested wall-clock time relates to the calendar of its zone.
 * `shifted` means the time does not exist (it fell inside a spring-forward gap);
 * `dt` is then the same wall clock advanced by the length of the gap, which is
 * the conventional reading of "02:30" on a day that has no 02:30.
 */
export type ResolvedLocal =
  | { readonly kind: 'ok'; readonly dt: DateTime }
  | { readonly kind: 'shifted'; readonly dt: DateTime }
  | { readonly kind: 'invalid' };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Resolves a local wall clock on a local calendar day to an instant.
 *
 * Luxon does not hand back an invalid DateTime for a time inside a DST gap — it
 * silently rolls forward onto the next existing instant (02:30 becomes 03:30 on a
 * spring-forward day) and reports `isValid: true`. Trusting that is how naive
 * implementations end up offering slots that never happen, so we detect the case
 * by round-tripping the wall clock and label it.
 *
 * For an ambiguous time (a fall-back hour that occurs twice) Luxon picks the
 * first, pre-transition offset — the one a person means when they say "01:30".
 */
export function resolveLocal(
  date: string,
  minutesFromMidnight: number,
  timezone: string,
): ResolvedLocal {
  const m = ISO_DATE.exec(date);
  if (!m) return { kind: 'invalid' };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // 24:00 is the end of the day, i.e. midnight of the day after.
  if (minutesFromMidnight >= 24 * 60) {
    const next = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (!next.isValid) return { kind: 'invalid' };
    const dt = next.plus({ days: 1 }).startOf('day');
    return { kind: 'ok', dt };
  }

  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone: timezone });
  if (!dt.isValid) return { kind: 'invalid' };
  if (dt.hour !== hour || dt.minute !== minute) return { kind: 'shifted', dt };
  return { kind: 'ok', dt };
}

/** Merges overlapping/adjacent busy spans so the fit check is a simple scan. */
export function mergeBusy(busy: readonly BusyInterval[]): BusyInterval[] {
  const sorted = busy
    .filter((b) => b.endsAtMs > b.startsAtMs)
    .slice()
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
  const out: BusyInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.startsAtMs <= last.endsAtMs) {
      if (cur.endsAtMs > last.endsAtMs) {
        out[out.length - 1] = { startsAtMs: last.startsAtMs, endsAtMs: cur.endsAtMs };
      }
    } else {
      out.push({ startsAtMs: cur.startsAtMs, endsAtMs: cur.endsAtMs });
    }
  }
  return out;
}

function overlapsBusy(startMs: number, endMs: number, busy: readonly BusyInterval[]): boolean {
  // Half-open [start, end): touching at the boundary is not an overlap.
  for (const b of busy) {
    if (b.startsAtMs >= endMs) break;
    if (b.endsAtMs > startMs) return true;
  }
  return false;
}

export interface WorkingSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The working stretches of one local day, resolved to instants. A boundary that
 * falls inside a DST gap is rolled forward by the length of the gap rather than
 * dropping the stretch, so a shift that starts at 02:30 on a 23-hour day simply
 * starts at 03:30 instead of vanishing from the calendar.
 */
export function workingSpansForDay(
  date: string,
  timezone: string,
  workingHours: readonly WorkingInterval[],
): WorkingSpan[] {
  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid) return [];
  // Luxon weekday: 1 = Monday … 7 = Sunday. Ours: 0 = Sunday … 6 = Saturday.
  const weekday = (day.weekday % 7) as Weekday;

  const spans: WorkingSpan[] = [];
  for (const wh of workingHours) {
    if (wh.weekday !== weekday) continue;
    const startMin = parseLocalTime(wh.startsLocal);
    const endMin = parseLocalTime(wh.endsLocal);
    if (endMin <= startMin) continue;

    const start = resolveLocal(date, startMin, timezone);
    const end = resolveLocal(date, endMin, timezone);
    if (start.kind === 'invalid' || end.kind === 'invalid') continue;

    const startMs = start.dt.toMillis();
    const endMs = end.dt.toMillis();
    if (endMs > startMs) spans.push({ startMs, endMs });
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

/* ---------------------------------- core ---------------------------------- */

const MIN_MS = 60_000;

/**
 * All bookable starts for one local day.
 *
 * The grid is walked in real time from each working stretch's start, so a day
 * that is 23 or 25 hours long produces exactly the slots that physically exist:
 * none are duplicated across a fall-back transition and none are invented inside
 * a spring-forward gap.
 */
export function slotsForDay(query: SlotQuery): Slot[] {
  const { date, rules, service, workingHours, nowMs } = query;
  const { timezone, slotStepMin, minLeadTimeMin, bookingHorizonDays } = rules;

  if (slotStepMin <= 0) throw new RangeError('slotStepMin must be positive');
  if (service.durationMin <= 0) throw new RangeError('durationMin must be positive');

  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid) return [];

  const horizonEndMs = DateTime.fromMillis(nowMs, { zone: timezone })
    .startOf('day')
    .plus({ days: bookingHorizonDays })
    .endOf('day')
    .toMillis();
  const earliestMs = nowMs + minLeadTimeMin * MIN_MS;

  const occupiedMin = service.durationMin + service.bufferAfterMin;
  const occupiedMs = occupiedMin * MIN_MS;
  const serviceMs = service.durationMin * MIN_MS;
  const stepMs = slotStepMin * MIN_MS;

  const busy = mergeBusy(query.busy);
  const spans = workingSpansForDay(date, timezone, workingHours);

  const slots: Slot[] = [];
  for (const span of spans) {
    for (let startMs = span.startMs; startMs + occupiedMs <= span.endMs; startMs += stepMs) {
      if (startMs < earliestMs) continue;
      if (startMs > horizonEndMs) break;
      const endMs = startMs + occupiedMs;
      if (overlapsBusy(startMs, endMs, busy)) continue;
      const local = DateTime.fromMillis(startMs, { zone: timezone });
      slots.push({
        startsAtMs: startMs,
        endsAtMs: endMs,
        serviceEndsAtMs: startMs + serviceMs,
        localTime: local.toFormat('HH:mm'),
        localDate: local.toFormat('yyyy-MM-dd'),
        ambiguous: false,
      });
    }
  }

  // Overlapping working stretches (a misconfigured schedule) could otherwise emit
  // the same instant twice.
  const seen = new Set<number>();
  const unique: Slot[] = [];
  for (const slot of slots) {
    if (seen.has(slot.startsAtMs)) continue;
    seen.add(slot.startsAtMs);
    unique.push(slot);
  }
  unique.sort((a, b) => a.startsAtMs - b.startsAtMs);

  // On a fall-back day the same wall clock maps to two distinct instants. Both are
  // bookable, so we keep them and flag the collision for the UI.
  const labelCounts = new Map<string, number>();
  for (const s of unique) labelCounts.set(s.localTime, (labelCounts.get(s.localTime) ?? 0) + 1);
  return unique.map((s) =>
    (labelCounts.get(s.localTime) ?? 0) > 1 ? { ...s, ambiguous: true } : s,
  );
}

/** Availability across a local date range, inclusive of both ends. */
export function slotsForRange(
  query: Omit<SlotQuery, 'date'> & { readonly from: string; readonly to: string },
): DayAvailability[] {
  const { from, to, rules } = query;
  const start = DateTime.fromISO(from, { zone: rules.timezone });
  const end = DateTime.fromISO(to, { zone: rules.timezone });
  if (!start.isValid || !end.isValid || end < start) return [];

  const out: DayAvailability[] = [];
  let cursor = start.startOf('day');
  const last = end.startOf('day');
  let guard = 0;
  while (cursor <= last && guard++ < 400) {
    const date = cursor.toFormat('yyyy-MM-dd');
    out.push({ date, slots: slotsForDay({ ...query, date }) });
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

/**
 * Server-side gate: is this exact start still bookable? Re-runs the same grid so
 * a client that hand-crafts a request cannot book off-grid or inside a break.
 */
export function isSlotBookable(query: SlotQuery, startsAtMs: number): boolean {
  return slotsForDay(query).some((s) => s.startsAtMs === startsAtMs);
}

/** The occupied span an appointment reserves; stored materialized in the DB. */
export function occupiedSpan(startsAtMs: number, service: ServiceDuration): BusyInterval {
  return {
    startsAtMs,
    endsAtMs: startsAtMs + (service.durationMin + service.bufferAfterMin) * MIN_MS,
  };
}

/** The next `limit` free slots at or after `fromMs`, scanning day by day. */
export function nextSlots(
  query: Omit<SlotQuery, 'date'> & { readonly fromDate: string },
  limit: number,
): Slot[] {
  const out: Slot[] = [];
  let cursor = DateTime.fromISO(query.fromDate, { zone: query.rules.timezone });
  if (!cursor.isValid) return out;
  for (let i = 0; i <= query.rules.bookingHorizonDays && out.length < limit; i++) {
    const date = cursor.toFormat('yyyy-MM-dd');
    for (const slot of slotsForDay({ ...query, date })) {
      out.push(slot);
      if (out.length >= limit) break;
    }
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

/** Luxon `Interval` view, for callers that want to do further interval math. */
export function toInterval(b: BusyInterval, zone: string): Interval {
  return Interval.fromDateTimes(
    DateTime.fromMillis(b.startsAtMs, { zone }),
    DateTime.fromMillis(b.endsAtMs, { zone }),
  );
}
