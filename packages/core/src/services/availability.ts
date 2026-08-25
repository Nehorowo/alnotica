/**
 * Availability: turns rows into the input the pure slot engine expects, then runs
 * it. The engine itself is in `packages/shared` and also runs in the browser —
 * this module is only the I/O around it.
 */
import {
  type Database,
  type ServiceRow,
  type StaffRow,
  type TenantRow,
  forTenant,
} from '@alnotica/db';
import {
  type BusyInterval,
  type DayAvailability,
  NotFoundError,
  type Slot,
  type SlotQuery,
  type SlotRules,
  type Weekday,
  type WorkingInterval,
  nextSlots,
  slotsForDay,
  slotsForRange,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import { TtlCache } from './cache.js';

/** 60 seconds: long enough to absorb a burst of taps, short enough to feel live. */
const AVAILABILITY_TTL_MS = 60_000;

const cache = new TtlCache<DayAvailability[]>(AVAILABILITY_TTL_MS);

export function availabilityCacheKey(
  staffId: string,
  serviceId: string,
  from: string,
  to: string,
): string {
  return `${staffId}|${serviceId}|${from}|${to}`;
}

/** Called on every change to a booking or a schedule. */
export function invalidateAvailability(staffId: string): void {
  cache.invalidatePrefix(`${staffId}|`);
}

export function invalidateAllAvailability(): void {
  cache.clear();
}

export function rulesFor(tenant: TenantRow): SlotRules {
  return {
    timezone: tenant.timezone,
    slotStepMin: tenant.slotStepMin,
    minLeadTimeMin: tenant.minLeadTimeMin,
    bookingHorizonDays: tenant.bookingHorizonDays,
  };
}

export function toWorkingIntervals(
  rows: readonly { weekday: number; startsLocal: string; endsLocal: string }[],
): WorkingInterval[] {
  return rows
    .filter((r) => r.weekday >= 0 && r.weekday <= 6)
    .map((r) => ({
      weekday: r.weekday as Weekday,
      startsLocal: r.startsLocal,
      endsLocal: r.endsLocal,
    }));
}

export interface AvailabilityRequest {
  readonly db: Database;
  readonly tenant: TenantRow;
  readonly service: ServiceRow;
  readonly staff: StaffRow;
  readonly from: string;
  readonly to: string;
  readonly nowMs?: number;
  /** Skip the cache when the caller is about to write. */
  readonly fresh?: boolean;
}

export async function loadSlotQuery(
  req: Omit<AvailabilityRequest, 'from' | 'to' | 'fresh'> & { from: string; to: string },
): Promise<Omit<SlotQuery, 'date'>> {
  const repo = forTenant(req.db, req.tenant.id);
  const zone = req.tenant.timezone;
  const nowMs = req.nowMs ?? Date.now();

  const fromDt = DateTime.fromISO(req.from, { zone });
  const toDt = DateTime.fromISO(req.to, { zone });
  if (!fromDt.isValid || !toDt.isValid) throw new NotFoundError('date range');

  // A day is padded on both sides so an appointment that spills over midnight is
  // still seen as busy.
  const windowFromMs = fromDt.startOf('day').minus({ days: 1 }).toMillis();
  const windowToMs = toDt.endOf('day').plus({ days: 1 }).toMillis();

  const [hours, busy] = await Promise.all([
    repo.schedule.workingHoursFor(req.staff.id),
    repo.appointments.busySpans([req.staff.id], windowFromMs, windowToMs),
  ]);

  return {
    rules: rulesFor(req.tenant),
    service: { durationMin: req.service.durationMin, bufferAfterMin: req.service.bufferAfterMin },
    workingHours: toWorkingIntervals(hours),
    busy: busy as BusyInterval[],
    nowMs,
  };
}

/** Availability across a date range, cached for a minute per (staff, service, range). */
export async function getAvailability(req: AvailabilityRequest): Promise<DayAvailability[]> {
  const key = availabilityCacheKey(req.staff.id, req.service.id, req.from, req.to);
  if (!req.fresh) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const base = await loadSlotQuery(req);
  const days = slotsForRange({ ...base, from: req.from, to: req.to });
  cache.set(key, days);
  return days;
}

/** The next N free slots — the plain-buttons fallback path uses this. */
export async function getNextSlots(
  req: Omit<AvailabilityRequest, 'from' | 'to'> & { fromDate: string; limit: number },
): Promise<Slot[]> {
  const horizonEnd = DateTime.fromISO(req.fromDate, { zone: req.tenant.timezone })
    .plus({ days: req.tenant.bookingHorizonDays })
    .toFormat('yyyy-MM-dd');
  const base = await loadSlotQuery({ ...req, from: req.fromDate, to: horizonEnd });
  return nextSlots({ ...base, fromDate: req.fromDate }, req.limit);
}

/**
 * Why a start is unavailable.
 *
 * The distinction matters to the person on the other end: "someone just took it,
 * here are the nearest free times" is a different message from "that is not a
 * time we offer", and answering the first with the second reads as a bug.
 */
export type SlotVerdict = 'free' | 'taken' | 'off_grid';

export async function classifySlot(
  req: Omit<AvailabilityRequest, 'from' | 'to' | 'fresh'>,
  startsAtMs: number,
): Promise<SlotVerdict> {
  const date = DateTime.fromMillis(startsAtMs, { zone: req.tenant.timezone }).toFormat(
    'yyyy-MM-dd',
  );
  const base = await loadSlotQuery({ ...req, from: date, to: date });

  if (slotsForDay({ ...base, date }).some((s) => s.startsAtMs === startsAtMs)) return 'free';
  // The same grid with nothing booked: if the start appears now, the only thing
  // wrong with it is that somebody else got there first.
  const onGrid = slotsForDay({ ...base, busy: [], date }).some((s) => s.startsAtMs === startsAtMs);
  return onGrid ? 'taken' : 'off_grid';
}

/**
 * Re-checks one exact start against fresh data. The Mini App has already drawn
 * the grid with the same function; this is the server having the last word.
 */
export async function isStillBookable(
  req: Omit<AvailabilityRequest, 'from' | 'to' | 'fresh'>,
  startsAtMs: number,
): Promise<boolean> {
  return (await classifySlot(req, startsAtMs)) === 'free';
}
