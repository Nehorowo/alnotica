/**
 * The Mini App API.
 *
 * Response shapes come from `packages/shared`, so the client parses exactly what
 * the server promises. Every route is scoped by tenant slug and every identifier
 * in the request is resolved through the tenant-scoped repository: an id that
 * belongs to a different tenant simply is not found, and the answer is 404.
 */
import {
  createBooking,
  getAvailability,
  isClientReachable,
  nearbyAlternatives,
} from '@alnotica/core';
import type {
  AppointmentRow,
  ClientRow,
  ServiceRow,
  StaffRow,
  TenantRow,
  TenantScopedRepo,
} from '@alnotica/db';
import {
  type AppointmentDto,
  type AvailabilityResponse,
  type BookResponse,
  type Currency,
  IDEMPOTENCY_HEADER,
  InitDataError,
  type ScheduleResponse,
  type ServiceDto,
  type SlotDto,
  SlotTakenError,
  availabilityQuerySchema,
  bookRequestSchema,
  formatMoney,
  isDomainError,
  scheduleQuerySchema,
  staffBookRequestSchema,
} from '@alnotica/shared';
import type { FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { authenticate, authenticateStaff } from '../lib/auth.js';
import type { AppContext } from '../lib/context.js';
import { notFound, sendError } from '../lib/errors.js';
import { idempotentBooking } from '../lib/idempotency.js';
import type { App } from '../lib/server.js';

const slugParams = z.object({ slug: z.string().min(2).max(32) });

function serviceDto(row: ServiceRow): ServiceDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMin: row.durationMin,
    bufferAfterMin: row.bufferAfterMin,
    priceMinor: row.priceMinor,
    currency: row.currency,
  };
}

export function appointmentDto(
  row: AppointmentRow,
  parts: { tenant: TenantRow; service: ServiceRow; staff: StaffRow; client: ClientRow },
): AppointmentDto {
  const local = DateTime.fromJSDate(row.startsAt, { zone: parts.tenant.timezone });
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    startsAtMs: row.startsAt.getTime(),
    endsAtMs: row.endsAt.getTime(),
    serviceName: parts.service.name,
    staffName: parts.staff.name,
    clientName: parts.client.name,
    priceMinor: row.priceMinor,
    currency: parts.service.currency,
    localDate: local.toFormat('yyyy-MM-dd'),
    localTime: local.toFormat('HH:mm'),
  };
}

/** Picks the master for an "any master" request: the first who can do the service. */
async function resolveStaff(
  repo: TenantScopedRepo,
  serviceId: string,
  requested: string,
): Promise<StaffRow | null> {
  if (requested !== 'any') return repo.staff.byId(requested);
  const candidates = await repo.services.staffFor(serviceId);
  return candidates[0] ?? null;
}

export function registerMiniAppRoutes(app: App, ctx: AppContext): void {
  /* ------------------------------ availability ----------------------------- */

  app.get('/api/miniapp/:slug/availability', async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return notFound(reply, 'tenant');

    const query = availabilityQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid query' } });
    }

    try {
      const identity = await authenticate(ctx, request, params.data.slug, 'read');
      if (!identity) return notFound(reply, 'tenant');

      const service = await identity.repo.services.byId(query.data.serviceId);
      if (!service || !service.isActive) return notFound(reply, 'service');

      const staff = await resolveStaff(identity.repo, service.id, query.data.staffId);
      if (!staff) return notFound(reply, 'staff');

      const days = await getAvailability({
        db: ctx.db,
        tenant: identity.tenant,
        service,
        staff,
        from: query.data.from,
        to: query.data.to,
      });

      const body: AvailabilityResponse = {
        tenant: {
          title: identity.tenant.title,
          timezone: identity.tenant.timezone,
          address: identity.tenant.address,
          bookingHorizonDays: identity.tenant.bookingHorizonDays,
        },
        service: serviceDto(service),
        staff: { id: staff.id, name: staff.name },
        days: days.map((d) => ({ date: d.date, slots: d.slots as SlotDto[] })),
      };
      return reply.send(body);
    } catch (e) {
      return handle(reply, e, ctx, request);
    }
  });

  /* --------------------------------- services ------------------------------ */

  app.get('/api/miniapp/:slug/services', async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return notFound(reply, 'tenant');
    try {
      const identity = await authenticate(ctx, request, params.data.slug, 'read');
      if (!identity) return notFound(reply, 'tenant');
      const services = await identity.repo.services.list();
      return reply.send({
        tenant: {
          title: identity.tenant.title,
          timezone: identity.tenant.timezone,
          address: identity.tenant.address,
        },
        services: services.map(serviceDto),
        staff: (await identity.repo.staff.list()).map((s) => ({ id: s.id, name: s.name })),
      });
    } catch (e) {
      return handle(reply, e, ctx, request);
    }
  });

  /* ----------------------------------- book -------------------------------- */

  app.post('/api/miniapp/:slug/book', async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return notFound(reply, 'tenant');

    const body = bookRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid body' } });
    }

    try {
      // A booking writes, so `initData` must be fresh to the minute.
      const identity = await authenticate(ctx, request, params.data.slug, 'write');
      if (!identity) return notFound(reply, 'tenant');

      const service = await identity.repo.services.byId(body.data.serviceId);
      if (!service || !service.isActive) return notFound(reply, 'service');

      const staff = await resolveStaff(identity.repo, service.id, body.data.staffId);
      if (!staff) return notFound(reply, 'staff');

      const client = await identity.repo.clients.upsertTelegram({
        telegramId: identity.user.id,
        name:
          [identity.user.first_name, identity.user.last_name].filter(Boolean).join(' ') || 'Клиент',
        username: identity.user.username ?? null,
      });

      const rawKey = request.headers[IDEMPOTENCY_HEADER];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

      const result = await idempotentBooking(ctx, {
        tenantId: identity.tenant.id,
        key: idempotencyKey,
        // The key is namespaced by tenant and user, so two people cannot collide
        // on a client-generated uuid.
        scope: `${identity.tenant.id}:${identity.user.id}`,
        run: async () => {
          const { appointment } = await createBooking(
            { db: ctx.db, queue: ctx.queue },
            {
              tenant: identity.tenant,
              service,
              staff,
              client,
              startsAtMs: body.data.startsAtMs,
              comment: body.data.comment ?? null,
              createdBy: 'client',
            },
          );
          const dto = appointmentDto(appointment, {
            tenant: identity.tenant,
            service,
            staff,
            client,
          });
          await notifyNewBooking(ctx, identity.tenant, appointment, {
            service,
            staff,
            client,
            reachable: isClientReachable(client),
          });
          return { appointment: dto, replayed: false } satisfies BookResponse;
        },
      });

      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (e) {
      if (e instanceof SlotTakenError) {
        // Do not answer "500"; answer "someone just took it, here is what is left".
        const identity = await authenticate(ctx, request, params.data.slug, 'write').catch(
          () => null,
        );
        const alternatives = identity ? await alternativesFor(ctx, identity, body.data) : [];
        return reply.code(409).send({
          error: {
            code: 'slot_taken',
            message: 'Этот слот только что заняли',
            alternatives,
          },
        });
      }
      return handle(reply, e, ctx, request);
    }
  });

  /* --------------------------------- schedule ------------------------------ */

  app.get('/api/miniapp/:slug/schedule', async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return notFound(reply, 'tenant');

    const query = scheduleQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid query' } });
    }

    try {
      const identity = await authenticateStaff(ctx, request, params.data.slug, 'read');
      if (!identity) return notFound(reply, 'tenant');

      const zone = identity.tenant.timezone;
      const fromMs = DateTime.fromISO(query.data.from, { zone }).startOf('day').toMillis();
      const toMs = DateTime.fromISO(query.data.to, { zone }).endOf('day').toMillis();

      const [appointments, services, staffList] = await Promise.all([
        identity.repo.appointments.listBetween(fromMs, toMs),
        identity.repo.services.list(true),
        identity.repo.staff.list(),
      ]);
      const timeOff = await identity.repo.schedule.listTimeOff(
        staffList.map((s) => s.id),
        fromMs,
        toMs,
      );

      const serviceById = new Map(services.map((s) => [s.id, s]));
      const staffById = new Map(staffList.map((s) => [s.id, s]));
      const clientIds = [...new Set(appointments.map((a) => a.clientId))];
      const clients = new Map<string, ClientRow>();
      for (const id of clientIds) {
        const c = await identity.repo.clients.byId(id);
        if (c) clients.set(id, c);
      }

      const body: ScheduleResponse = {
        tenant: { title: identity.tenant.title, timezone: zone },
        from: query.data.from,
        to: query.data.to,
        staff: staffList.map((s) => ({ id: s.id, name: s.name })),
        services: services.map(serviceDto),
        appointments: appointments.flatMap((a) => {
          const service = serviceById.get(a.serviceId);
          const staff = staffById.get(a.staffId);
          const client = clients.get(a.clientId);
          if (!service || !staff || !client) return [];
          return [
            {
              ...appointmentDto(a, { tenant: identity.tenant, service, staff, client }),
              staffId: a.staffId,
              comment: a.comment,
            },
          ];
        }),
        timeOff: timeOff.map((o) => ({
          id: o.id,
          staffId: o.staffId,
          startsAtMs: o.startsAt.getTime(),
          endsAtMs: o.endsAt.getTime(),
          reason: o.reason,
        })),
      };
      return reply.send(body);
    } catch (e) {
      return handle(reply, e, ctx, request);
    }
  });

  /* ------------------------- staff-created bookings ------------------------ */

  app.post('/api/miniapp/:slug/staff-book', async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return notFound(reply, 'tenant');

    const body = staffBookRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid body' } });
    }

    try {
      const identity = await authenticateStaff(ctx, request, params.data.slug, 'write');
      if (!identity) return notFound(reply, 'tenant');

      const service = await identity.repo.services.byId(body.data.serviceId);
      if (!service) return notFound(reply, 'service');
      const staff = await identity.repo.staff.byId(body.data.staffId);
      if (!staff) return notFound(reply, 'staff');

      let client: ClientRow | null = null;
      if (body.data.clientId) {
        client = await identity.repo.clients.byId(body.data.clientId);
        if (!client) return notFound(reply, 'client');
      } else if (body.data.clientName) {
        // A client the master typed in: no telegramId, therefore no reminders.
        client = await identity.repo.clients.createManual({
          name: body.data.clientName,
          phone: body.data.clientPhone ?? null,
        });
      }
      if (!client) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'client is required' } });
      }

      const { appointment, clientReachable } = await createBooking(
        { db: ctx.db, queue: ctx.queue },
        {
          tenant: identity.tenant,
          service,
          staff,
          client,
          startsAtMs: body.data.startsAtMs,
          comment: body.data.comment ?? null,
          createdBy: 'staff',
          // The master is allowed to book outside the published grid.
          force: true,
        },
      );

      return reply.code(201).send({
        appointment: appointmentDto(appointment, {
          tenant: identity.tenant,
          service,
          staff,
          client,
        }),
        replayed: false,
        clientReachable,
      });
    } catch (e) {
      return handle(reply, e, ctx, request);
    }
  });
}

async function alternativesFor(
  ctx: AppContext,
  identity: NonNullable<Awaited<ReturnType<typeof authenticate>>>,
  request: { serviceId: string; staffId: string; startsAtMs: number },
): Promise<SlotDto[]> {
  const service = await identity.repo.services.byId(request.serviceId);
  if (!service) return [];
  const staff = await resolveStaff(identity.repo, service.id, request.staffId);
  if (!staff) return [];
  const days = await nearbyAlternatives(
    { db: ctx.db, queue: ctx.queue },
    { tenant: identity.tenant, service, staff, aroundMs: request.startsAtMs },
  );
  return days.flatMap((d) => d.slots as SlotDto[]).slice(0, 8);
}

/** Tells the master about a new booking straight away. */
async function notifyNewBooking(
  ctx: AppContext,
  tenant: TenantRow,
  appointment: AppointmentRow,
  parts: { service: ServiceRow; staff: StaffRow; client: ClientRow; reachable: boolean },
): Promise<void> {
  if (parts.staff.telegramId === null) return;
  const local = DateTime.fromJSDate(appointment.startsAt, { zone: tenant.timezone });
  const price = appointment.priceMinor
    ? ` · ${formatMoney(appointment.priceMinor, parts.service.currency as Currency)}`
    : '';
  // The text itself is assembled in the worker, which owns all message templates;
  // here we only hand it the facts it needs.
  await ctx.queue.enqueue({
    kind: 'send_message',
    payload: {
      kind: 'send_message',
      botId: tenant.botId,
      chatId: parts.staff.telegramId.toString(),
      text: [
        '<b>Новая запись</b>',
        `${escapeHtml(parts.client.name)} · ${escapeHtml(parts.service.name)}${price}`,
        `${local.toFormat('dd.MM')} в ${local.toFormat('HH:mm')}`,
        parts.reachable ? '' : 'Клиент без Telegram — напоминания не придут.',
      ]
        .filter(Boolean)
        .join('\n'),
      disablePreview: true,
      marketing: false,
      tenantId: tenant.id,
    },
    priority: 10,
    dedupeKey: `new_booking:${appointment.id}`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function handle(
  reply: Parameters<typeof sendError>[0],
  e: unknown,
  ctx: AppContext,
  request: FastifyRequest,
) {
  if (e instanceof InitDataError) {
    ctx.log.warn({ path: request.url, reason: e.message }, 'initData rejected');
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid init data' } });
  }
  if (!isDomainError(e)) ctx.log.error({ err: e, path: request.url }, 'miniapp route failed');
  return sendError(reply, e);
}
