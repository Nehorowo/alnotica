/**
 * Booking orchestration: everything that has to happen around an appointment
 * changing state. Used by both the bot (worker) and the Mini App API, so the two
 * paths cannot drift apart.
 *
 * The rule that matters most in this file: a cancelled or rescheduled appointment
 * must leave no scheduled job behind. A client who cancels and is reminded anyway
 * has stopped trusting the product, and no later feature wins that back.
 */
import {
  type AppointmentRow,
  type ClientRow,
  type Database,
  type ServiceRow,
  SlotAlreadyTakenError,
  type StaffRow,
  type TenantRow,
  forTenant,
} from '@alnotica/db';
import {
  ASK_NO_SHOW_DELAY_MIN,
  type AppointmentAction,
  type AppointmentStatus,
  type AskNoShowPayload,
  NotFoundError,
  PRIORITY,
  type Plan,
  PlanLimitError,
  type ReminderPayload,
  SlotNotAvailableError,
  SlotTakenError,
  appointmentCancelKey,
  appointmentStatusSchema,
  askNoShowAtMs,
  askNoShowDedupeKey,
  assertCanCreateAppointment,
  assertClientAppointmentCap,
  assertClientMayCancel,
  generateSlug,
  initialStatus,
  monthBounds,
  nextStatus,
  occupiedSpan,
  pendingExpiresAtMs,
  planReminders,
  reminderDedupeKey,
} from '@alnotica/shared';
import { classifySlot, getAvailability, invalidateAvailability } from './availability.js';
import type { Queue } from './queue.js';

/**
 * The status column is `text` with a CHECK constraint, so the database already
 * refuses nonsense — but a row is still data from outside the process, and an
 * older deployment could in principle have written a status this build does not
 * know. Parsing it turns that into a clear error instead of a bad `switch`.
 */
function statusOf(row: AppointmentRow): AppointmentStatus {
  return appointmentStatusSchema.parse(row.status);
}

export interface BookingDeps {
  readonly db: Database;
  readonly queue: Queue;
  readonly nowMs?: number;
}

export interface CreateBookingInput {
  readonly tenant: TenantRow;
  readonly service: ServiceRow;
  readonly staff: StaffRow;
  readonly client: ClientRow;
  readonly startsAtMs: number;
  readonly comment?: string | null;
  readonly createdBy: 'client' | 'staff';
  /** Set when this booking replaces another one. */
  readonly rescheduledFromId?: string | null;
  /** Staff-created bookings bypass the availability grid; the master knows best. */
  readonly force?: boolean;
}

export interface CreateBookingResult {
  readonly appointment: AppointmentRow;
  readonly remindersScheduled: number;
  readonly clientReachable: boolean;
}

/**
 * Whether the bot is allowed to message this client at all.
 *
 * A bot cannot write first: only someone who pressed /start can be reached. A
 * client the master typed in by hand has never done that, so they get no
 * reminders — and the UI has to say so, or the master will think we are broken.
 */
export function isClientReachable(client: ClientRow): boolean {
  return client.telegramId !== null && client.consentAt !== null && !client.isBlocked;
}

export async function createBooking(
  deps: BookingDeps,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(deps.db, input.tenant.id);

  if (input.createdBy === 'client') {
    // Free-tier meter and the anti-prank cap apply to clients, not to the master.
    const { startMs, endMs } = monthBounds(nowMs, input.tenant.timezone);
    const used = await repo.appointments.countCreatedBetween(startMs, endMs);
    assertCanCreateAppointment(input.tenant.plan, used);

    const active = await repo.appointments.activeFutureCountForClient(input.client.id, nowMs);
    assertClientAppointmentCap(active);
  }

  if (!input.force) {
    const verdict = await classifySlot(
      { db: deps.db, tenant: input.tenant, service: input.service, staff: input.staff, nowMs },
      input.startsAtMs,
    );
    // A start that is on the grid but occupied is "someone beat you to it", not
    // "that is not a valid time" — the caller shows a different screen for each.
    if (verdict === 'taken') throw new SlotTakenError(input.startsAtMs);
    if (verdict === 'off_grid') throw new SlotNotAvailableError('not_on_grid');
  }

  const span = occupiedSpan(input.startsAtMs, {
    durationMin: input.service.durationMin,
    bufferAfterMin: input.service.bufferAfterMin,
  });
  const status = initialStatus(input.tenant.autoConfirm);

  let appointment: AppointmentRow;
  try {
    appointment = await repo.appointments.create({
      staffId: input.staff.id,
      serviceId: input.service.id,
      clientId: input.client.id,
      ref: generateSlug(10),
      startsAt: new Date(span.startsAtMs),
      endsAt: new Date(span.endsAtMs),
      status,
      priceMinor: input.service.priceMinor,
      comment: input.comment ?? null,
      createdBy: input.createdBy,
      rescheduledFromId: input.rescheduledFromId ?? null,
    });
  } catch (e) {
    // The database refused an overlap: someone took this slot a moment ago.
    if (e instanceof SlotAlreadyTakenError) throw new SlotTakenError(input.startsAtMs);
    throw e;
  }

  invalidateAvailability(input.staff.id);

  const reachable = isClientReachable(input.client);
  const remindersScheduled = await scheduleAppointmentJobs(deps, {
    tenant: input.tenant,
    appointment,
    clientReachable: reachable,
    nowMs,
  });

  return { appointment, remindersScheduled, clientReachable: reachable };
}

export interface ScheduleJobsInput {
  readonly tenant: TenantRow;
  readonly appointment: AppointmentRow;
  readonly clientReachable: boolean;
  readonly nowMs: number;
}

/**
 * Puts the whole job set for one appointment in place: reminders, the expiry
 * timer for an unconfirmed booking, and the "did they show up?" question.
 *
 * Every one of them carries the same `cancelKey`, which is what makes
 * `cancelAppointmentJobs` a single UPDATE.
 */
export async function scheduleAppointmentJobs(
  deps: BookingDeps,
  input: ScheduleJobsInput,
): Promise<number> {
  const { appointment, tenant, nowMs } = input;
  const cancelKey = appointmentCancelKey(appointment.id);
  const startsAtMs = appointment.startsAt.getTime();
  const endsAtMs = appointment.endsAt.getTime();

  const planned = planReminders({
    startsAtMs,
    nowMs,
    offsetsMin: tenant.reminderOffsetsMin,
    clientReachable: input.clientReachable,
  });

  for (const reminder of planned) {
    const payload: ReminderPayload = {
      kind: 'reminder',
      appointmentId: appointment.id,
      offsetMin: reminder.offsetMin,
    };
    await deps.queue.enqueue({
      kind: 'reminder',
      payload,
      priority: PRIORITY.reminder,
      runAt: new Date(reminder.runAtMs),
      cancelKey,
      dedupeKey: reminderDedupeKey(appointment.id, reminder.offsetMin),
    });
  }

  // An unconfirmed booking must not hold the slot forever.
  if (appointment.status === 'pending') {
    await deps.queue.enqueue({
      kind: 'reminder',
      payload: { kind: 'reminder', appointmentId: appointment.id, offsetMin: 1 },
      priority: PRIORITY.transactional,
      runAt: new Date(pendingExpiresAtMs(appointment.createdAt.getTime())),
      cancelKey,
      dedupeKey: `expire:${appointment.id}`,
    });
  }

  // The no-show question is the source of the product's headline metric, so it is
  // scheduled at booking time rather than discovered later by a sweep.
  const askPayload: AskNoShowPayload = { kind: 'ask_no_show', appointmentId: appointment.id };
  await deps.queue.enqueue({
    kind: 'ask_no_show',
    payload: askPayload,
    priority: PRIORITY.transactional,
    runAt: new Date(askNoShowAtMs(endsAtMs, ASK_NO_SHOW_DELAY_MIN)),
    cancelKey,
    dedupeKey: askNoShowDedupeKey(appointment.id),
  });

  return planned.length;
}

/** Extinguishes every job belonging to an appointment. Returns how many died. */
export async function cancelAppointmentJobs(
  deps: BookingDeps,
  appointmentId: string,
): Promise<number> {
  return deps.queue.cancelByKey(appointmentCancelKey(appointmentId));
}

export interface CancelInput {
  readonly tenant: TenantRow;
  readonly appointmentId: string;
  readonly by: 'client' | 'staff';
  readonly reason?: string | null;
  /** Client cancellations respect the cancel window; the master's never do. */
  readonly enforceWindow?: boolean;
}

export interface CancelResult {
  readonly appointment: AppointmentRow;
  readonly jobsCancelled: number;
}

export async function cancelBooking(deps: BookingDeps, input: CancelInput): Promise<CancelResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(deps.db, input.tenant.id);

  const existing = await repo.appointments.byId(input.appointmentId);
  if (!existing) throw new NotFoundError('appointment');

  if (input.by === 'client' && (input.enforceWindow ?? true)) {
    assertClientMayCancel({
      startsAtMs: existing.startsAt.getTime(),
      nowMs,
      cancelWindowHours: input.tenant.cancelWindowHours,
    });
  }

  const action: AppointmentAction = input.by === 'client' ? 'cancel_by_client' : 'cancel_by_staff';
  // Throws on an invalid transition before touching the database.
  const target = nextStatus(statusOf(existing), action);

  const updated = await repo.appointments.transition(
    existing.id,
    ['pending', 'confirmed'],
    target,
    {
      cancelledAt: new Date(nowMs),
      cancelReason: input.reason ?? null,
    },
  );
  if (!updated) throw new NotFoundError('appointment');

  // Order matters only for readability; both are idempotent.
  const jobsCancelled = await cancelAppointmentJobs(deps, existing.id);
  invalidateAvailability(existing.staffId);

  return { appointment: updated, jobsCancelled };
}

export interface RescheduleInput {
  readonly tenant: TenantRow;
  readonly appointmentId: string;
  readonly newStartsAtMs: number;
  readonly by: 'client' | 'staff';
}

export interface RescheduleResult {
  readonly previous: AppointmentRow;
  readonly created: AppointmentRow;
  readonly jobsCancelled: number;
}

/**
 * A reschedule is a cancellation plus a new booking, linked by
 * `rescheduledFromId`. Keeping both rows preserves the history the master needs
 * when a client claims they never moved anything.
 */
export async function rescheduleBooking(
  deps: BookingDeps,
  input: RescheduleInput,
): Promise<RescheduleResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(deps.db, input.tenant.id);

  const existing = await repo.appointments.byId(input.appointmentId);
  if (!existing) throw new NotFoundError('appointment');

  const [service, staff, client] = await Promise.all([
    repo.services.byId(existing.serviceId),
    repo.staff.byId(existing.staffId),
    repo.clients.byId(existing.clientId),
  ]);
  if (!service || !staff || !client) throw new NotFoundError('appointment');

  // Free the old span first, or the EXCLUDE constraint will reject a move of one
  // slot into an overlapping one.
  const target = nextStatus(statusOf(existing), 'reschedule');
  const released = await repo.appointments.transition(
    existing.id,
    ['pending', 'confirmed'],
    target,
    {
      cancelledAt: new Date(nowMs),
    },
  );
  if (!released) throw new NotFoundError('appointment');

  const jobsCancelled = await cancelAppointmentJobs(deps, existing.id);
  invalidateAvailability(existing.staffId);

  try {
    const { appointment } = await createBooking(deps, {
      tenant: input.tenant,
      service,
      staff,
      client,
      startsAtMs: input.newStartsAtMs,
      comment: existing.comment,
      createdBy: input.by,
      rescheduledFromId: existing.id,
      force: input.by === 'staff',
    });
    return { previous: released, created: appointment, jobsCancelled };
  } catch (e) {
    // The new time turned out to be unavailable: put the original back so the
    // client is not left with nothing.
    await repo.appointments.transition(existing.id, [target], existing.status, {
      cancelledAt: null,
    });
    await scheduleAppointmentJobs(deps, {
      tenant: input.tenant,
      appointment: existing,
      clientReachable: isClientReachable(client),
      nowMs,
    });
    throw e;
  }
}

export interface OutcomeInput {
  readonly tenant: TenantRow;
  readonly appointmentId: string;
  readonly outcome: 'completed' | 'no_show';
}

/** The master's verdict on a finished visit. Feeds the no-show rate. */
export async function recordOutcome(
  deps: BookingDeps,
  input: OutcomeInput,
): Promise<AppointmentRow> {
  const repo = forTenant(deps.db, input.tenant.id);
  const updated = await repo.appointments.transition(
    input.appointmentId,
    ['confirmed', 'pending', 'completed', 'no_show'],
    input.outcome,
  );
  if (!updated) throw new NotFoundError('appointment');
  await cancelAppointmentJobs(deps, input.appointmentId);
  return updated;
}

/** The client tapped "I'll be there" on a reminder — an extra signal against no-show. */
export async function confirmByClient(
  deps: BookingDeps,
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentRow | null> {
  const repo = forTenant(deps.db, tenantId);
  const existing = await repo.appointments.byId(appointmentId);
  if (!existing) return null;
  if (existing.confirmedByClientAt) return existing;
  return repo.appointments.transition(appointmentId, ['pending', 'confirmed'], 'confirmed', {
    confirmedByClientAt: new Date(deps.nowMs ?? Date.now()),
  });
}

/** Alternatives offered when the chosen slot has just been taken. */
export async function nearbyAlternatives(
  deps: BookingDeps,
  input: {
    tenant: TenantRow;
    service: ServiceRow;
    staff: StaffRow;
    aroundMs: number;
    limit?: number;
  },
): Promise<ReturnType<typeof getAvailability> extends Promise<infer T> ? T : never> {
  const zone = input.tenant.timezone;
  const date = new Date(input.aroundMs).toLocaleDateString('en-CA', { timeZone: zone });
  return getAvailability({
    db: deps.db,
    tenant: input.tenant,
    service: input.service,
    staff: input.staff,
    from: date,
    to: date,
    nowMs: deps.nowMs ?? Date.now(),
    fresh: true,
  });
}

export { PlanLimitError };
