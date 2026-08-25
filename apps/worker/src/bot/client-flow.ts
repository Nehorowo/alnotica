/**
 * The client's path: deep link → consent → service → master → time → booked.
 *
 * The plain-button route is not a fallback bolted on later — it is the primary
 * implementation here, and the Mini App is an accelerator on top of it. Older
 * Telegram clients, desktop users and anyone whose Mini App fails to load still
 * complete a booking with nothing but inline buttons.
 */
import {
  cancelBooking,
  confirmByClient,
  createBooking,
  getNextSlots,
  isClientReachable,
} from '@alnotica/core';
import type { ClientRow, ServiceRow, StaffRow, TenantRow } from '@alnotica/db';
import {
  OutsideCancelWindowError,
  type Slot,
  SlotTakenError,
  decodeCallback,
  encodeCallback,
  esc,
  html,
  isWithinCancelWindow,
  parseStartPayload,
  startLink,
} from '@alnotica/shared';
import type { Composer } from 'grammy';
import { DateTime } from 'luxon';
import { type BotContext, chatId, displayName, senderId } from './context.js';
import { clientAppointmentCard, formatDayHeading, formatPrice, formatWhen } from './format.js';
import { type Keyboard, PAGE_SIZE, button, grid, urlButton, webAppButton } from './keyboards.js';
import { renderMenu } from './menu.js';
import { texts } from './texts.js';

/** How many slots the button grid shows before "other days". */
const SLOT_BUTTONS = 8;

async function loadTenantFromSession(ctx: BotContext): Promise<TenantRow | null> {
  const tenantId = ctx.session.tenantId;
  if (!tenantId) return null;
  return ctx.tenants.byId(tenantId);
}

/** Upserts the client row for whoever is talking, inside the tenant. */
async function ensureClient(ctx: BotContext, tenant: TenantRow): Promise<ClientRow | null> {
  const telegramId = senderId(ctx);
  if (telegramId === null) return null;
  const repo = ctx.tenantRepo(tenant.id);
  const client = await repo.clients.upsertTelegram({
    telegramId,
    name: displayName(ctx),
    username: ctx.from?.username ?? null,
  });
  ctx.session.clientId = client.id;
  return client;
}

/* --------------------------------- consent -------------------------------- */

function consentKeyboard(): Keyboard {
  return [
    [button(texts.consent.accept, { a: 'consent', v: 'accept' })],
    [button(texts.consent.decline, { a: 'consent', v: 'decline' })],
  ];
}

async function askConsent(ctx: BotContext, tenant: TenantRow): Promise<void> {
  await renderMenu(ctx, {
    text: [
      `<b>${esc(texts.consent.title)}</b>`,
      texts.consent.body(ctx.deps.env.POLICY_URL, ctx.deps.env.OFFER_URL),
      esc(tenant.title),
    ].join('\n\n'),
    keyboard: consentKeyboard(),
  });
}

/* ------------------------------- main client ------------------------------ */

function clientMenuKeyboard(): Keyboard {
  return [
    [button(texts.client.book, { a: 'menu', v: 'book' })],
    [button(texts.client.myAppointments, { a: 'menu', v: 'mine' })],
    [button(texts.client.contacts, { a: 'menu', v: 'contacts' })],
  ];
}

async function showClientHome(ctx: BotContext, tenant: TenantRow): Promise<void> {
  await renderMenu(ctx, {
    text: texts.client.greeting(esc(tenant.title), tenant.address ? esc(tenant.address) : null),
    keyboard: clientMenuKeyboard(),
  });
}

async function showServices(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const services = await repo.services.list();
  if (services.length === 0) {
    await renderMenu(ctx, {
      text: texts.client.noSlots,
      keyboard: [[button(texts.common.back, { a: 'menu', v: 'home' })]],
    });
    return;
  }

  const rows: Keyboard = services.map((s) => [
    button(texts.client.serviceLine(s.name, s.durationMin, s.priceMinor, s.currency).slice(0, 60), {
      a: 'svc',
      id: s.id,
    }),
  ]);
  rows.push([button(texts.common.back, { a: 'menu', v: 'home' })]);

  await renderMenu(ctx, { text: texts.client.chooseService, keyboard: rows });
}

async function showStaffPicker(
  ctx: BotContext,
  tenant: TenantRow,
  service: ServiceRow,
): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const staff = await repo.services.staffFor(service.id);

  // One master: skip a screen that would only ever have one answer.
  if (staff.length <= 1) {
    const only = staff[0];
    if (!only) {
      await renderMenu(ctx, {
        text: texts.client.noSlots,
        keyboard: [[button(texts.common.back, { a: 'menu', v: 'book' })]],
      });
      return;
    }
    await showSlots(ctx, tenant, service, only, 0);
    return;
  }

  const rows: Keyboard = staff.map((s) => [button(s.name, { a: 'staff', id: s.id })]);
  rows.push([button(texts.client.anyStaff, { a: 'staff', id: 'any' })]);
  rows.push([button(texts.common.back, { a: 'menu', v: 'book' })]);
  await renderMenu(ctx, { text: texts.client.chooseStaff, keyboard: rows });
}

function slotButtonLabel(slot: Slot, timezone: string): string {
  const dt = DateTime.fromMillis(slot.startsAtMs, { zone: timezone });
  // A fall-back day repeats a wall clock; the offset disambiguates the two.
  const suffix = slot.ambiguous ? ` (UTC${dt.toFormat('ZZ')})` : '';
  return `${slot.localTime}${suffix}`;
}

/**
 * The plain-button time picker: the next N free slots, grouped by day, plus a
 * Mini App button for clients whose Telegram supports it.
 */
async function showSlots(
  ctx: BotContext,
  tenant: TenantRow,
  service: ServiceRow,
  staff: StaffRow,
  page: number,
): Promise<void> {
  ctx.session.booking = {
    tenantId: tenant.id,
    serviceId: service.id,
    staffId: staff.id,
    page,
  };

  const nowMs = ctx.now();
  const fromDate = DateTime.fromMillis(nowMs, { zone: tenant.timezone })
    .plus({ days: page * 7 })
    .toFormat('yyyy-MM-dd');

  const slots = await getNextSlots({
    db: ctx.deps.db,
    tenant,
    service,
    staff,
    fromDate,
    limit: SLOT_BUTTONS,
    nowMs,
  });

  const rows: Keyboard = [];
  const miniAppUrl = miniAppLink(ctx, tenant, service, staff);
  if (miniAppUrl) rows.push([webAppButton(texts.client.openCalendar, miniAppUrl)]);

  if (slots.length === 0) {
    rows.push([button(texts.client.otherDays, { a: 'more', p: page + 1 })]);
    rows.push([button(texts.common.back, { a: 'menu', v: 'book' })]);
    await renderMenu(ctx, { text: texts.client.noSlots, keyboard: rows });
    return;
  }

  // Group by local day so the grid reads as a calendar rather than a list.
  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const list = byDay.get(slot.localDate) ?? [];
    list.push(slot);
    byDay.set(slot.localDate, list);
  }

  const lines: string[] = [
    `<b>${esc(service.name)}</b>`,
    esc(
      texts.client
        .serviceLine('', service.durationMin, service.priceMinor, service.currency)
        .replace(/^ · /, ''),
    ),
  ];

  for (const [date, daySlots] of byDay) {
    const heading = formatDayHeading(DateTime.fromISO(date, { zone: tenant.timezone }));
    lines.push(`\n${esc(heading)}`);
    rows.push(
      ...grid(
        daySlots.map((s) =>
          button(slotButtonLabel(s, tenant.timezone), { a: 'slot', t: s.startsAtMs }),
        ),
        4,
      ),
    );
  }

  rows.push([button(texts.client.otherDays, { a: 'more', p: page + 1 })]);
  rows.push([button(texts.common.back, { a: 'menu', v: 'book' })]);

  await renderMenu(ctx, { text: lines.join('\n'), keyboard: rows });
}

function miniAppLink(
  ctx: BotContext,
  tenant: TenantRow,
  service: ServiceRow,
  staff: StaffRow,
): string | null {
  const base = ctx.deps.env.PUBLIC_URL;
  if (!base) return null;
  const url = new URL('/miniapp/', base);
  url.searchParams.set('tenant', tenant.slug);
  url.searchParams.set('service', service.id);
  url.searchParams.set('staff', staff.id);
  return url.toString();
}

/* --------------------------------- booking -------------------------------- */

async function book(ctx: BotContext, startsAtMs: number): Promise<void> {
  const draft = ctx.session.booking;
  if (!draft?.serviceId || !draft.staffId) {
    await ctx.answerCallbackQuery({ text: texts.common.somethingWentWrong, show_alert: true });
    return;
  }

  const tenant = await ctx.tenants.byId(draft.tenantId);
  if (!tenant) return;
  const repo = ctx.tenantRepo(tenant.id);

  const [service, staff, client] = await Promise.all([
    repo.services.byId(draft.serviceId),
    repo.staff.byId(draft.staffId),
    ensureClient(ctx, tenant),
  ]);
  if (!service || !staff || !client) return;

  if (!client.consentAt) {
    await askConsent(ctx, tenant);
    return;
  }

  try {
    const { appointment } = await createBooking(
      { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
      {
        tenant,
        service,
        staff,
        client,
        startsAtMs,
        createdBy: 'client',
      },
    );

    const card = clientAppointmentCard({ tenant, appointment, service, staff, client });
    await renderMenu(ctx, {
      text: [
        appointment.status === 'pending'
          ? esc(texts.client.pendingCard)
          : `<b>${esc(texts.client.booked)}</b>`,
        String(card),
      ].join('\n\n'),
      keyboard: [
        [
          button(texts.client.reschedule, { a: 'appt', o: 'resched', id: appointment.id }),
          button(texts.client.cancelBooking, { a: 'appt', o: 'cancel', id: appointment.id }),
        ],
        [button(texts.common.menu, { a: 'menu', v: 'home' })],
      ],
    });

    await notifyStaffOfBooking(ctx, tenant, staff, client, service, appointment.startsAt);
  } catch (error) {
    if (error instanceof SlotTakenError) {
      // Not a 500 and not a dead end: show what is still free right now.
      await ctx.answerCallbackQuery({ text: texts.errors.slotTaken, show_alert: true });
      await showSlots(ctx, tenant, service, staff, draft.page);
      return;
    }
    throw error;
  }
}

async function notifyStaffOfBooking(
  ctx: BotContext,
  tenant: TenantRow,
  staff: StaffRow,
  client: ClientRow,
  service: ServiceRow,
  startsAt: Date,
): Promise<void> {
  const price = formatPrice(service.priceMinor, service.currency);
  await ctx.deps.queue.enqueue({
    kind: 'send_message',
    payload: {
      kind: 'send_message',
      botId: tenant.botId,
      chatId: staff.telegramId.toString(),
      text: [
        html`<b>${texts.staff.newBooking}</b>`.value,
        html`${client.name} · ${service.name}${price ? ` · ${price}` : ''}`.value,
        html`${formatWhen(startsAt, tenant.timezone)}`.value,
        isClientReachable(client) ? '' : esc(texts.staff.manualNoReminders),
      ]
        .filter(Boolean)
        .join('\n'),
      disablePreview: true,
      marketing: false,
      tenantId: tenant.id,
      clientId: client.id,
    },
    priority: 10,
  });
}

/* ------------------------------ my bookings ------------------------------- */

async function showMyAppointments(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const client = await ensureClient(ctx, tenant);
  if (!client) return;
  const repo = ctx.tenantRepo(tenant.id);

  const [upcoming, past] = await Promise.all([
    repo.appointments.forClient(client.id, PAGE_SIZE, true, ctx.now()),
    repo.appointments.forClient(client.id, 5, false, ctx.now()),
  ]);

  if (upcoming.length === 0 && past.length === 0) {
    await renderMenu(ctx, {
      text: texts.client.noAppointments,
      keyboard: [[button(texts.common.back, { a: 'menu', v: 'home' })]],
    });
    return;
  }

  const services = new Map<string, ServiceRow>();
  for (const appt of [...upcoming, ...past]) {
    if (!services.has(appt.serviceId)) {
      const s = await repo.services.byId(appt.serviceId);
      if (s) services.set(appt.serviceId, s);
    }
  }

  const lines: string[] = [];
  const rows: Keyboard = [];

  if (upcoming.length > 0) {
    lines.push(`<b>${esc(texts.client.upcoming)}</b>`);
    for (const appt of upcoming) {
      const service = services.get(appt.serviceId);
      lines.push(
        html`${formatWhen(appt.startsAt, tenant.timezone)} · ${service?.name ?? ''}`.value,
      );
      rows.push([
        button(`${formatWhen(appt.startsAt, tenant.timezone)}`, {
          a: 'appt',
          o: 'show',
          id: appt.id,
        }),
      ]);
    }
  }

  if (past.length > 0) {
    lines.push(`\n<b>${esc(texts.client.past)}</b>`);
    for (const appt of past) {
      const service = services.get(appt.serviceId);
      lines.push(
        html`${formatWhen(appt.startsAt, tenant.timezone)} · ${service?.name ?? ''}`.value,
      );
    }
  }

  rows.push([button(texts.common.back, { a: 'menu', v: 'home' })]);
  await renderMenu(ctx, { text: lines.join('\n'), keyboard: rows });
}

async function showAppointmentCard(
  ctx: BotContext,
  tenant: TenantRow,
  appointmentId: string,
): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const appointment = await repo.appointments.byId(appointmentId);
  if (!appointment) {
    await ctx.answerCallbackQuery({ text: texts.errors.notFound, show_alert: true });
    return;
  }

  const [service, staff, client] = await Promise.all([
    repo.services.byId(appointment.serviceId),
    repo.staff.byId(appointment.staffId),
    repo.clients.byId(appointment.clientId),
  ]);
  if (!service || !staff || !client) return;

  const canCancel = isWithinCancelWindow({
    startsAtMs: appointment.startsAt.getTime(),
    nowMs: ctx.now(),
    cancelWindowHours: tenant.cancelWindowHours,
  });

  const rows: Keyboard = [];
  if (appointment.status === 'confirmed' || appointment.status === 'pending') {
    rows.push([
      button(texts.client.reschedule, { a: 'appt', o: 'resched', id: appointment.id }),
      canCancel
        ? button(texts.client.cancelBooking, { a: 'appt', o: 'cancel', id: appointment.id })
        : button(texts.client.contactStaff, { a: 'appt', o: 'show', id: appointment.id }),
    ]);
  }
  rows.push([button(texts.common.back, { a: 'menu', v: 'mine' })]);

  const card = clientAppointmentCard({ tenant, appointment, service, staff, client });
  const note = canCancel ? '' : `\n\n${esc(texts.client.cancelTooLate(tenant.cancelWindowHours))}`;
  await renderMenu(ctx, { text: `${String(card)}${note}`, keyboard: rows });
}

async function doCancel(ctx: BotContext, tenant: TenantRow, appointmentId: string): Promise<void> {
  try {
    const { appointment } = await cancelBooking(
      { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
      { tenant, appointmentId, by: 'client' },
    );
    await ctx.answerCallbackQuery({ text: texts.client.cancelled });
    await notifyStaffOfCancellation(ctx, tenant, appointment.id);
    await showMyAppointments(ctx, tenant);
  } catch (error) {
    if (error instanceof OutsideCancelWindowError) {
      await ctx.answerCallbackQuery({
        text: texts.client.cancelTooLate(tenant.cancelWindowHours),
        show_alert: true,
      });
      return;
    }
    throw error;
  }
}

async function notifyStaffOfCancellation(
  ctx: BotContext,
  tenant: TenantRow,
  appointmentId: string,
): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const appointment = await repo.appointments.byId(appointmentId);
  if (!appointment) return;
  const [staff, client, service] = await Promise.all([
    repo.staff.byId(appointment.staffId),
    repo.clients.byId(appointment.clientId),
    repo.services.byId(appointment.serviceId),
  ]);
  if (!staff || !client || !service) return;

  await ctx.deps.queue.enqueue({
    kind: 'send_message',
    payload: {
      kind: 'send_message',
      botId: tenant.botId,
      chatId: staff.telegramId.toString(),
      text: [
        html`<b>${texts.staff.bookingCancelled}</b>`.value,
        html`${client.name} · ${service.name}`.value,
        html`${formatWhen(appointment.startsAt, tenant.timezone)}`.value,
      ].join('\n'),
      // The freed window is the most valuable thing a master can act on quickly.
      keyboard: [
        [
          {
            text: texts.broadcast.windowOpenedButton,
            data: encodeCallback({ a: 'bc', o: 'window', id: appointment.id }),
          },
        ],
      ],
      disablePreview: true,
      marketing: false,
      tenantId: tenant.id,
    },
    priority: 10,
  });
}

/* -------------------------------- wiring ---------------------------------- */

export function registerClientFlow(composer: Composer<BotContext>): void {
  composer.command('start', async (ctx) => {
    const payloadRaw = ctx.match;
    const payload = parseStartPayload(typeof payloadRaw === 'string' ? payloadRaw : undefined);

    if (!payload) {
      // No deep link: this is either a master or someone who found the bot by name.
      return;
    }

    const tenant = await resolveTenantFromPayload(ctx, payload);
    if (!tenant) {
      await ctx.reply(texts.errors.notFound);
      return;
    }

    ctx.session.tenantId = tenant.id;
    const client = await ensureClient(ctx, tenant);
    if (!client) return;

    if (!client.consentAt) {
      await askConsent(ctx, tenant);
      return;
    }

    if (payload.kind === 'service') {
      const services = await ctx.tenantRepo(tenant.id).services.list();
      const service = services[payload.serviceIdx];
      if (service) {
        await showStaffPicker(ctx, tenant, service);
        return;
      }
    }

    await showClientHome(ctx, tenant);
  });

  composer.on('callback_query:data', async (ctx, next) => {
    const data = decodeCallback(ctx.callbackQuery.data);
    if (!data) return next();

    const tenant = await loadTenantFromSession(ctx);
    if (!tenant) return next();
    const repo = ctx.tenantRepo(tenant.id);

    switch (data.a) {
      case 'consent': {
        const client = await ensureClient(ctx, tenant);
        if (!client) return;
        if (data.v === 'decline') {
          await ctx.answerCallbackQuery();
          await renderMenu(ctx, { text: texts.consent.declined });
          return;
        }
        await repo.clients.recordConsent(client.id);
        await ctx.answerCallbackQuery();
        await showClientHome(ctx, tenant);
        return;
      }

      case 'menu': {
        await ctx.answerCallbackQuery();
        switch (data.v) {
          case 'home':
            return showClientHome(ctx, tenant);
          case 'book':
            return showServices(ctx, tenant);
          case 'mine':
            return showMyAppointments(ctx, tenant);
          case 'contacts':
            return renderMenu(ctx, {
              text: [
                html`<b>${tenant.title}</b>`.value,
                tenant.address ? html`${tenant.address}`.value : '',
                tenant.phone ? html`${tenant.phone}`.value : '',
              ]
                .filter(Boolean)
                .join('\n'),
              keyboard: [[button(texts.common.back, { a: 'menu', v: 'home' })]],
            });
          default:
            return next();
        }
      }

      case 'svc': {
        const service = await repo.services.byId(data.id);
        if (!service) {
          await ctx.answerCallbackQuery({ text: texts.errors.notFound, show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        return showStaffPicker(ctx, tenant, service);
      }

      case 'staff': {
        const draft = ctx.session.booking;
        const serviceId = draft?.serviceId;
        if (!serviceId) return next();
        const service = await repo.services.byId(serviceId);
        if (!service) return next();

        const staff =
          data.id === 'any'
            ? (await repo.services.staffFor(service.id))[0]
            : await repo.staff.byId(data.id);
        if (!staff) {
          await ctx.answerCallbackQuery({ text: texts.errors.notFound, show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        return showSlots(ctx, tenant, service, staff, 0);
      }

      case 'more': {
        const draft = ctx.session.booking;
        if (!draft?.serviceId || !draft.staffId) return next();
        const [service, staff] = await Promise.all([
          repo.services.byId(draft.serviceId),
          repo.staff.byId(draft.staffId),
        ]);
        if (!service || !staff) return next();
        await ctx.answerCallbackQuery();
        return showSlots(ctx, tenant, service, staff, data.p);
      }

      case 'slot': {
        await ctx.answerCallbackQuery();
        return book(ctx, data.t);
      }

      case 'appt': {
        switch (data.o) {
          case 'show':
            await ctx.answerCallbackQuery();
            return showAppointmentCard(ctx, tenant, data.id);
          case 'cancel':
            return doCancel(ctx, tenant, data.id);
          case 'confirm': {
            await confirmByClient(
              { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
              tenant.id,
              data.id,
            );
            await ctx.answerCallbackQuery({ text: texts.client.confirmedAttendance });
            return;
          }
          case 'resched': {
            const appointment = await repo.appointments.byId(data.id);
            if (!appointment) return;
            const service = await repo.services.byId(appointment.serviceId);
            const staff = await repo.staff.byId(appointment.staffId);
            if (!service || !staff) return;
            // Rescheduling reuses the picker; booking the new slot cancels the old.
            ctx.session.booking = {
              tenantId: tenant.id,
              serviceId: service.id,
              staffId: staff.id,
              page: 0,
            };
            await ctx.answerCallbackQuery();
            return showSlots(ctx, tenant, service, staff, 0);
          }
          default:
            return next();
        }
      }

      default:
        return next();
    }
  });
}

async function resolveTenantFromPayload(
  ctx: BotContext,
  payload: ReturnType<typeof parseStartPayload>,
): Promise<TenantRow | null> {
  if (!payload) return null;
  switch (payload.kind) {
    case 'master':
    case 'service':
      return ctx.tenants.bySlug(payload.slug);
    case 'ref': {
      // Arrived from a reminder or an invitation; `ref` is globally unique.
      const found = await ctx.tenants.byAppointmentRef(payload.ref);
      return found?.tenant ?? null;
    }
  }
}

export { showClientHome, showSlots, ensureClient };
