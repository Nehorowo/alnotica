/**
 * Tenant-scoped data access.
 *
 * Every method here is bound to one `tenantId` at construction, so there is no
 * call site where the filter could be forgotten. Cross-tenant reads therefore
 * return nothing rather than someone else's data, and the API turns "nothing"
 * into a 404 — never a 403, which would confirm the row exists.
 */
import { type StatsRow, appointmentStatusSchema } from '@alnotica/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../client.js';
import { isExclusionViolation } from '../client.js';
import {
  type AppointmentRow,
  type BroadcastRow,
  type ClientRow,
  type MediaRow,
  type ServiceRow,
  type StaffRow,
  type TimeOffRow,
  type WorkingHoursRow,
  appointment,
  broadcast,
  client,
  media,
  reminderLog,
  service,
  staff,
  staffService,
  timeOff,
  workingHours,
} from '../schema.js';

/** Statuses that reserve time. Mirrors BLOCKING_STATUSES and the EXCLUDE clause. */
const BLOCKING = ['pending', 'confirmed'] as const;

export class SlotAlreadyTakenError extends Error {
  readonly code = 'slot_taken';
  constructor() {
    super('slot is already taken');
    this.name = 'SlotAlreadyTakenError';
  }
}

export interface CreateAppointmentRow {
  readonly staffId: string;
  readonly serviceId: string;
  readonly clientId: string;
  readonly ref: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  readonly priceMinor?: number | null;
  readonly comment?: string | null;
  readonly createdBy: 'client' | 'staff';
  readonly rescheduledFromId?: string | null;
}

export interface BusySpan {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export function forTenant(db: Database, tenantId: string) {
  /* -------------------------------- services ------------------------------- */

  const services = {
    async list(includeInactive = false): Promise<ServiceRow[]> {
      const where = includeInactive
        ? eq(service.tenantId, tenantId)
        : and(eq(service.tenantId, tenantId), eq(service.isActive, true));
      return db
        .select()
        .from(service)
        .where(where)
        .orderBy(asc(service.sortOrder), asc(service.name));
    },

    async byId(id: string): Promise<ServiceRow | null> {
      const [row] = await db
        .select()
        .from(service)
        .where(and(eq(service.id, id), eq(service.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async create(
      input: Omit<ServiceRow, 'id' | 'tenantId' | 'createdAt' | 'isActive'>,
    ): Promise<ServiceRow> {
      const [row] = await db
        .insert(service)
        .values({ ...input, tenantId })
        .returning();
      if (!row) throw new Error('insert into service returned nothing');
      return row;
    },

    async update(id: string, patch: Partial<ServiceRow>): Promise<ServiceRow | null> {
      const { tenantId: _ignored, id: _id, ...safe } = patch;
      // Drizzle rejects an empty SET; an empty patch is a no-op, not an error.
      if (Object.keys(safe).length === 0) return services.byId(id);
      const [row] = await db
        .update(service)
        .set(safe)
        .where(and(eq(service.id, id), eq(service.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },

    /** Services are deactivated, never deleted: past appointments still point at them. */
    async deactivate(id: string): Promise<boolean> {
      const rows = await db
        .update(service)
        .set({ isActive: false })
        .where(and(eq(service.id, id), eq(service.tenantId, tenantId)))
        .returning({ id: service.id });
      return rows.length > 0;
    },

    /** Which masters perform a service; an empty link table means "everyone". */
    async staffFor(serviceId: string): Promise<StaffRow[]> {
      const linked = await db
        .select({ s: staff })
        .from(staffService)
        .innerJoin(staff, eq(staff.id, staffService.staffId))
        .where(
          and(
            eq(staffService.serviceId, serviceId),
            eq(staff.tenantId, tenantId),
            eq(staff.isActive, true),
          ),
        )
        .orderBy(asc(staff.name));
      if (linked.length > 0) return linked.map((r) => r.s);
      return staffMembers.list();
    },

    async link(staffId: string, serviceId: string): Promise<void> {
      await db.insert(staffService).values({ staffId, serviceId }).onConflictDoNothing();
    },

    async unlink(staffId: string, serviceId: string): Promise<void> {
      await db
        .delete(staffService)
        .where(and(eq(staffService.staffId, staffId), eq(staffService.serviceId, serviceId)));
    },
  };

  /* --------------------------------- staff --------------------------------- */

  const staffMembers = {
    async list(includeInactive = false): Promise<StaffRow[]> {
      const where = includeInactive
        ? eq(staff.tenantId, tenantId)
        : and(eq(staff.tenantId, tenantId), eq(staff.isActive, true));
      return db.select().from(staff).where(where).orderBy(asc(staff.name));
    },

    async byId(id: string): Promise<StaffRow | null> {
      const [row] = await db
        .select()
        .from(staff)
        .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async byTelegramId(telegramId: bigint): Promise<StaffRow | null> {
      const [row] = await db
        .select()
        .from(staff)
        .where(and(eq(staff.telegramId, telegramId), eq(staff.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async create(input: {
      telegramId: bigint;
      name: string;
      role: 'owner' | 'staff';
    }): Promise<StaffRow> {
      const [row] = await db
        .insert(staff)
        .values({ ...input, tenantId })
        .returning();
      if (!row) throw new Error('insert into staff returned nothing');
      return row;
    },

    async update(id: string, patch: Partial<StaffRow>): Promise<StaffRow | null> {
      const { tenantId: _t, id: _i, ...safe } = patch;
      if (Object.keys(safe).length === 0) return staffMembers.byId(id);
      const [row] = await db
        .update(staff)
        .set(safe)
        .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },
  };

  /* -------------------------------- schedule ------------------------------- */

  const schedule = {
    async workingHoursFor(staffId: string): Promise<WorkingHoursRow[]> {
      const owned = await staffMembers.byId(staffId);
      if (!owned) return [];
      return db
        .select()
        .from(workingHours)
        .where(eq(workingHours.staffId, staffId))
        .orderBy(asc(workingHours.weekday), asc(workingHours.startsLocal));
    },

    /** Replaces one weekday wholesale — the UI edits a day at a time. */
    async setWeekday(
      staffId: string,
      weekday: number,
      intervals: readonly { startsLocal: string; endsLocal: string }[],
    ): Promise<void> {
      const owned = await staffMembers.byId(staffId);
      if (!owned) return;
      await db.transaction(async (tx) => {
        await tx
          .delete(workingHours)
          .where(and(eq(workingHours.staffId, staffId), eq(workingHours.weekday, weekday)));
        if (intervals.length > 0) {
          await tx.insert(workingHours).values(intervals.map((i) => ({ staffId, weekday, ...i })));
        }
      });
    },

    async addTimeOff(
      staffId: string,
      startsAt: Date,
      endsAt: Date,
      reason?: string,
    ): Promise<TimeOffRow | null> {
      const owned = await staffMembers.byId(staffId);
      if (!owned) return null;
      const [row] = await db
        .insert(timeOff)
        .values({ staffId, startsAt, endsAt, reason: reason ?? null })
        .returning();
      return row ?? null;
    },

    async listTimeOff(
      staffIds: readonly string[],
      fromMs: number,
      toMs: number,
    ): Promise<TimeOffRow[]> {
      if (staffIds.length === 0) return [];
      return db
        .select()
        .from(timeOff)
        .innerJoin(staff, eq(staff.id, timeOff.staffId))
        .where(
          and(
            eq(staff.tenantId, tenantId),
            inArray(timeOff.staffId, [...staffIds]),
            lt(timeOff.startsAt, new Date(toMs)),
            gt(timeOff.endsAt, new Date(fromMs)),
          ),
        )
        .then((rows) => rows.map((r) => r.time_off));
    },

    async removeTimeOff(id: string): Promise<boolean> {
      const rows = await db
        .delete(timeOff)
        .where(
          and(
            eq(timeOff.id, id),
            inArray(
              timeOff.staffId,
              db.select({ id: staff.id }).from(staff).where(eq(staff.tenantId, tenantId)),
            ),
          ),
        )
        .returning({ id: timeOff.id });
      return rows.length > 0;
    },
  };

  /* -------------------------------- clients -------------------------------- */

  const clients = {
    async byId(id: string): Promise<ClientRow | null> {
      const [row] = await db
        .select()
        .from(client)
        .where(and(eq(client.id, id), eq(client.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async byTelegramId(telegramId: bigint): Promise<ClientRow | null> {
      const [row] = await db
        .select()
        .from(client)
        .where(and(eq(client.telegramId, telegramId), eq(client.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    /** Upsert on `(tenant_id, telegram_id)` — the deep-link entry point. */
    async upsertTelegram(input: {
      telegramId: bigint;
      name: string;
      username?: string | null;
      source?: string;
    }): Promise<ClientRow> {
      const [row] = await db
        .insert(client)
        .values({
          tenantId,
          telegramId: input.telegramId,
          name: input.name,
          username: input.username ?? null,
          source: input.source ?? 'deeplink',
        })
        .onConflictDoUpdate({
          target: [client.tenantId, client.telegramId],
          // The unique index is partial, so ON CONFLICT has to repeat its predicate
          // or Postgres cannot match it to a constraint.
          targetWhere: isNotNull(client.telegramId),
          set: { name: input.name, username: input.username ?? null },
        })
        .returning();
      if (!row) throw new Error('upsert into client returned nothing');
      return row;
    },

    /** A client the master typed in. No `telegramId`, therefore no reminders. */
    async createManual(input: {
      name: string;
      phone?: string | null;
      notes?: string | null;
    }): Promise<ClientRow> {
      const [row] = await db
        .insert(client)
        .values({
          tenantId,
          name: input.name,
          phone: input.phone ?? null,
          notes: input.notes ?? null,
          source: 'manual',
        })
        .returning();
      if (!row) throw new Error('insert into client returned nothing');
      return row;
    },

    async update(id: string, patch: Partial<ClientRow>): Promise<ClientRow | null> {
      const { tenantId: _t, id: _i, ...safe } = patch;
      if (Object.keys(safe).length === 0) return clients.byId(id);
      const [row] = await db
        .update(client)
        .set(safe)
        .where(and(eq(client.id, id), eq(client.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },

    async recordConsent(id: string): Promise<void> {
      await db
        .update(client)
        .set({ consentAt: new Date() })
        .where(and(eq(client.id, id), eq(client.tenantId, tenantId), isNull(client.consentAt)));
    },

    /** Called on a 403 from Telegram; the appointment itself is left alone. */
    async markBlocked(id: string): Promise<void> {
      await db
        .update(client)
        .set({ isBlocked: true })
        .where(and(eq(client.id, id), eq(client.tenantId, tenantId)));
    },

    async optOut(id: string): Promise<void> {
      await db
        .update(client)
        .set({ marketingOptOut: true })
        .where(and(eq(client.id, id), eq(client.tenantId, tenantId)));
    },

    async search(query: string, limit = 8, offset = 0): Promise<ClientRow[]> {
      const like = `%${query.trim().toLowerCase()}%`;
      return db
        .select()
        .from(client)
        .where(
          and(
            eq(client.tenantId, tenantId),
            query.trim() === ''
              ? undefined
              : or(
                  sql`lower(${client.name}) LIKE ${like}`,
                  sql`lower(coalesce(${client.phone}, '')) LIKE ${like}`,
                ),
          ),
        )
        .orderBy(asc(client.name))
        .limit(limit)
        .offset(offset);
    },

    /** Client ids who have ever completed a given service — a broadcast audience. */
    async idsWhoUsedService(serviceId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ id: appointment.clientId })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            eq(appointment.serviceId, serviceId),
            eq(appointment.status, 'completed'),
          ),
        );
      return rows.map((r) => r.id);
    },

    async count(): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(client)
        .where(eq(client.tenantId, tenantId));
      return row?.n ?? 0;
    },
  };

  /* ------------------------------ appointments ----------------------------- */

  const appointments = {
    /**
     * Inserts an appointment, translating a violation of `appointment_no_overlap`
     * into a domain error. The database is the arbiter: two clients tapping the
     * same slot in the same millisecond cannot both win, no matter what the
     * application checked a moment earlier.
     */
    async create(input: CreateAppointmentRow): Promise<AppointmentRow> {
      try {
        const [row] = await db
          .insert(appointment)
          .values({
            tenantId,
            staffId: input.staffId,
            serviceId: input.serviceId,
            clientId: input.clientId,
            ref: input.ref,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            status: input.status,
            priceMinor: input.priceMinor ?? null,
            comment: input.comment ?? null,
            createdBy: input.createdBy,
            rescheduledFromId: input.rescheduledFromId ?? null,
          })
          .returning();
        if (!row) throw new Error('insert into appointment returned nothing');
        return row;
      } catch (e) {
        if (isExclusionViolation(e, 'appointment_no_overlap')) throw new SlotAlreadyTakenError();
        throw e;
      }
    },

    async byId(id: string): Promise<AppointmentRow | null> {
      const [row] = await db
        .select()
        .from(appointment)
        .where(and(eq(appointment.id, id), eq(appointment.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async byRef(ref: string): Promise<AppointmentRow | null> {
      const [row] = await db
        .select()
        .from(appointment)
        .where(and(eq(appointment.ref, ref), eq(appointment.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    /**
     * Applies a status change, but only from an expected current status. The
     * `inArray` guard makes the update itself the concurrency check: two taps on
     * "cancel" produce one cancellation and one `null`.
     */
    async transition(
      id: string,
      from: readonly string[],
      to: string,
      patch: Partial<AppointmentRow> = {},
    ): Promise<AppointmentRow | null> {
      const { tenantId: _t, id: _i, ...safe } = patch;
      const [row] = await db
        .update(appointment)
        .set({ ...safe, status: to })
        .where(
          and(
            eq(appointment.id, id),
            eq(appointment.tenantId, tenantId),
            inArray(appointment.status, [...from]),
          ),
        )
        .returning();
      return row ?? null;
    },

    /** Everything that occupies `staffId`'s calendar in a window, in epoch ms. */
    async busySpans(
      staffIds: readonly string[],
      fromMs: number,
      toMs: number,
    ): Promise<BusySpan[]> {
      if (staffIds.length === 0) return [];
      const from = new Date(fromMs);
      const to = new Date(toMs);
      const booked = await db
        .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            inArray(appointment.staffId, [...staffIds]),
            inArray(appointment.status, [...BLOCKING]),
            lt(appointment.startsAt, to),
            gt(appointment.endsAt, from),
          ),
        );
      const off = await schedule.listTimeOff(staffIds, fromMs, toMs);
      return [
        ...booked.map((b) => ({ startsAtMs: b.startsAt.getTime(), endsAtMs: b.endsAt.getTime() })),
        ...off.map((o) => ({ startsAtMs: o.startsAt.getTime(), endsAtMs: o.endsAt.getTime() })),
      ];
    },

    async listBetween(fromMs: number, toMs: number, staffId?: string): Promise<AppointmentRow[]> {
      return db
        .select()
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            staffId ? eq(appointment.staffId, staffId) : undefined,
            gte(appointment.startsAt, new Date(fromMs)),
            lt(appointment.startsAt, new Date(toMs)),
            ne(appointment.status, 'rescheduled'),
          ),
        )
        .orderBy(asc(appointment.startsAt));
    },

    async forClient(
      clientId: string,
      limit = 10,
      upcoming = true,
      nowMs = Date.now(),
    ): Promise<AppointmentRow[]> {
      const now = new Date(nowMs);
      return db
        .select()
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            eq(appointment.clientId, clientId),
            upcoming ? gte(appointment.startsAt, now) : lt(appointment.startsAt, now),
            upcoming ? inArray(appointment.status, [...BLOCKING]) : undefined,
          ),
        )
        .orderBy(upcoming ? asc(appointment.startsAt) : desc(appointment.startsAt))
        .limit(limit);
    },

    /** Guards against one client blocking out a whole week for fun. */
    async activeFutureCountForClient(clientId: string, nowMs = Date.now()): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            eq(appointment.clientId, clientId),
            gte(appointment.startsAt, new Date(nowMs)),
            inArray(appointment.status, [...BLOCKING]),
          ),
        );
      return row?.n ?? 0;
    },

    /** The free-tier meter: bookings created inside the current calendar month. */
    async countCreatedBetween(fromMs: number, toMs: number): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            gte(appointment.createdAt, new Date(fromMs)),
            lt(appointment.createdAt, new Date(toMs)),
            ne(appointment.status, 'expired'),
          ),
        );
      return row?.n ?? 0;
    },

    /** Confirmed appointments whose end is in the past and that need a verdict. */
    async awaitingOutcome(beforeMs: number, limit = 100): Promise<AppointmentRow[]> {
      return db
        .select()
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            eq(appointment.status, 'confirmed'),
            lt(appointment.endsAt, new Date(beforeMs)),
          ),
        )
        .orderBy(asc(appointment.endsAt))
        .limit(limit);
    },

    async isFirstVisit(clientId: string, beforeMs: number): Promise<boolean> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            eq(appointment.clientId, clientId),
            lt(appointment.startsAt, new Date(beforeMs)),
            eq(appointment.status, 'completed'),
          ),
        );
      return (row?.n ?? 0) === 0;
    },
  };

  /* ---------------------------------- media --------------------------------- */

  const mediaRefs = {
    async create(input: {
      botId: string;
      fileId: string;
      fileUniqueId: string;
      kind: string;
      caption?: string | null;
    }): Promise<MediaRow> {
      const [row] = await db
        .insert(media)
        .values({ ...input, tenantId, caption: input.caption ?? null })
        .returning();
      if (!row) throw new Error('insert into media returned nothing');
      return row;
    },

    async byId(id: string): Promise<MediaRow | null> {
      const [row] = await db
        .select()
        .from(media)
        .where(and(eq(media.id, id), eq(media.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    /**
     * A `file_id` only works for the bot that received the file. Moving a tenant
     * to its own bot therefore invalidates every reference; we ask for a re-upload
     * rather than downloading the files ourselves, because storing bytes is the
     * one thing this product must never start doing.
     */
    async invalidateForBotChange(newBotId: string): Promise<number> {
      const rows = await db
        .update(media)
        .set({ needsReupload: true })
        .where(and(eq(media.tenantId, tenantId), ne(media.botId, newBotId)))
        .returning({ id: media.id });
      return rows.length;
    },
  };

  /* ------------------------------- broadcasts ------------------------------- */

  const broadcasts = {
    async create(input: {
      text: string;
      mediaId: string | null;
      audience: unknown;
      status: string;
    }): Promise<BroadcastRow> {
      const [row] = await db
        .insert(broadcast)
        .values({
          tenantId,
          text: input.text,
          mediaId: input.mediaId,
          audience: input.audience as never,
          status: input.status,
        })
        .returning();
      if (!row) throw new Error('insert into broadcast returned nothing');
      return row;
    },

    async byId(id: string): Promise<BroadcastRow | null> {
      const [row] = await db
        .select()
        .from(broadcast)
        .where(and(eq(broadcast.id, id), eq(broadcast.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async update(id: string, patch: Partial<BroadcastRow>): Promise<BroadcastRow | null> {
      const { tenantId: _t, id: _i, ...safe } = patch;
      if (Object.keys(safe).length === 0) return broadcasts.byId(id);
      const [row] = await db
        .update(broadcast)
        .set(safe)
        .where(and(eq(broadcast.id, id), eq(broadcast.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },

    async list(limit = 10): Promise<BroadcastRow[]> {
      return db
        .select()
        .from(broadcast)
        .where(eq(broadcast.tenantId, tenantId))
        .orderBy(desc(broadcast.createdAt))
        .limit(limit);
    },

    /**
     * Counts towards the four-a-month quota.
     *
     * A broadcast waiting on a moderator counts: it is going to go out once
     * approved, and leaving it uncounted would let a brand-new tenant queue up a
     * dozen for the moderator and then send them all. Drafts and rejections do not.
     */
    async countSince(sinceMs: number): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(broadcast)
        .where(
          and(
            eq(broadcast.tenantId, tenantId),
            gte(broadcast.createdAt, new Date(sinceMs)),
            inArray(broadcast.status, ['pending_moderation', 'approved', 'sending', 'sent']),
          ),
        );
      return row?.n ?? 0;
    },

    async countEverSent(): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(broadcast)
        .where(
          and(eq(broadcast.tenantId, tenantId), inArray(broadcast.status, ['sending', 'sent'])),
        );
      return row?.n ?? 0;
    },

    /**
     * When this tenant last put a broadcast into the world — sent or merely
     * submitted. The cooldown is measured from submission, not from delivery, so
     * that two sends cannot be queued back to back while a moderator is asleep.
     */
    async lastSentAt(): Promise<Date | null> {
      const [row] = await db
        .select({
          at: sql<string | null>`max(coalesce(${broadcast.startedAt}, ${broadcast.createdAt}))`,
        })
        .from(broadcast)
        .where(and(eq(broadcast.tenantId, tenantId), ne(broadcast.status, 'rejected')));
      return row?.at ? new Date(row.at) : null;
    },

    async recordProgress(id: string, sent: number, failed: number): Promise<void> {
      await db
        .update(broadcast)
        .set({
          sent: sql`${broadcast.sent} + ${sent}`,
          failed: sql`${broadcast.failed} + ${failed}`,
        })
        .where(and(eq(broadcast.id, id), eq(broadcast.tenantId, tenantId)));
    },
  };

  /* ----------------------------- reminder log ------------------------------ */

  const reminders = {
    async record(input: {
      appointmentId: string;
      offsetMin: number;
      delivered: boolean;
      error?: string | null;
      /** Explicit so the statistics window is driven by the caller's clock. */
      sentAt?: Date;
    }): Promise<void> {
      await db
        .insert(reminderLog)
        .values({
          tenantId,
          appointmentId: input.appointmentId,
          offsetMin: input.offsetMin,
          delivered: input.delivered,
          error: input.error ?? null,
          ...(input.sentAt ? { sentAt: input.sentAt } : {}),
        })
        .onConflictDoNothing({ target: [reminderLog.appointmentId, reminderLog.offsetMin] });
    },

    /** The "reminders delivered: N, confirmed: M" line the master pays for. */
    async deliveryStats(
      fromMs: number,
      toMs: number,
    ): Promise<{ remindersSent: number; remindersConfirmed: number }> {
      const [sentRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(reminderLog)
        .where(
          and(
            eq(reminderLog.tenantId, tenantId),
            eq(reminderLog.delivered, true),
            gte(reminderLog.sentAt, new Date(fromMs)),
            lt(reminderLog.sentAt, new Date(toMs)),
          ),
        );
      const [confirmedRow] = await db
        .select({ n: sql<number>`count(DISTINCT ${appointment.id})::int` })
        .from(appointment)
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            isNotNull(appointment.confirmedByClientAt),
            gte(appointment.startsAt, new Date(fromMs)),
            lt(appointment.startsAt, new Date(toMs)),
          ),
        );
      return { remindersSent: sentRow?.n ?? 0, remindersConfirmed: confirmedRow?.n ?? 0 };
    },
  };

  /* --------------------------------- stats --------------------------------- */

  const stats = {
    /**
     * One pass over the period; the arithmetic itself lives in `packages/shared`.
     * The status column is `text`, so it is parsed rather than cast — a row is
     * data from outside this process even when the process wrote it.
     */
    async rows(fromMs: number, toMs: number): Promise<StatsRow[]> {
      const rows = await db
        .select({
          status: appointment.status,
          priceMinor: appointment.priceMinor,
          serviceId: appointment.serviceId,
          serviceName: service.name,
          clientId: appointment.clientId,
          isFirstVisit: sql<boolean>`${client.createdAt} >= ${new Date(fromMs).toISOString()}::timestamptz`,
        })
        .from(appointment)
        .innerJoin(service, eq(service.id, appointment.serviceId))
        .innerJoin(client, eq(client.id, appointment.clientId))
        .where(
          and(
            eq(appointment.tenantId, tenantId),
            gte(appointment.startsAt, new Date(fromMs)),
            lt(appointment.startsAt, new Date(toMs)),
          ),
        );
      return rows.map((r) => ({ ...r, status: appointmentStatusSchema.parse(r.status) }));
    },

    /**
     * Everyone this tenant is actually allowed to send marketing to: has a
     * Telegram id, accepted the notice, has not blocked the bot and has not
     * opted out. Every audience filter starts from this set.
     */
    async reachableClients(limit = 2000): Promise<ClientRow[]> {
      return db
        .select()
        .from(client)
        .where(
          and(
            eq(client.tenantId, tenantId),
            isNotNull(client.telegramId),
            isNotNull(client.consentAt),
            eq(client.isBlocked, false),
            eq(client.marketingOptOut, false),
          ),
        )
        .orderBy(asc(client.createdAt))
        .limit(limit);
    },

    /** Clients who have not been seen for a while — the "a window opened" audience. */
    async dormantClients(sinceMs: number, limit = 500): Promise<ClientRow[]> {
      return db
        .select()
        .from(client)
        .where(
          and(
            eq(client.tenantId, tenantId),
            isNotNull(client.telegramId),
            isNotNull(client.consentAt),
            eq(client.isBlocked, false),
            eq(client.marketingOptOut, false),
            sql`NOT EXISTS (
              SELECT 1 FROM ${appointment} a
               WHERE a.client_id = ${client.id}
                 AND a.starts_at >= ${new Date(sinceMs).toISOString()}::timestamptz
                 AND a.status IN ('completed', 'confirmed', 'pending')
            )`,
          ),
        )
        .limit(limit);
    },
  };

  return {
    tenantId,
    services,
    staff: staffMembers,
    schedule,
    clients,
    appointments,
    media: mediaRefs,
    broadcasts,
    reminders,
    stats,
  };
}

export type TenantScopedRepo = ReturnType<typeof forTenant>;
