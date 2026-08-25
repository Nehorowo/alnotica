/**
 * The master's cabinet. There is no web admin panel by design: everything the
 * master does happens in this chat.
 *
 * Registration is five steps — name, field, time zone, first service, schedule —
 * and ends with the deep link they paste into their profile bio. That link is the
 * whole distribution model, so the last screen says exactly what to do with it.
 */
import { cancelBooking, recordOutcome } from '@alnotica/core';
import type { AppointmentRow, ServiceRow, StaffRow, TenantRow } from '@alnotica/db';
import {
  type CallbackData,
  type Currency,
  type Plan,
  TENANT_KINDS,
  type TenantKind,
  averageTicketMinor,
  computeStats,
  decodeCallback,
  esc,
  estimatedSavedMinor,
  formatMoney,
  formatPercent,
  generateSlug,
  hasFeature,
  html,
  isValidSlug,
  monthBounds,
  monthlyQuota,
  parseLocalTime,
  startLink,
  tenantKindSchema,
} from '@alnotica/shared';
import type { Composer, NextFunction } from 'grammy';
import { DateTime } from 'luxon';
import { type BotContext, displayName, senderId } from './context.js';
import { formatDayHeading, formatTime, formatWhen, staffAppointmentCard } from './format.js';
import { type Keyboard, PAGE_SIZE, button, grid, paginationRow, urlButton } from './keyboards.js';
import { renderMenu } from './menu.js';
import { texts } from './texts.js';

const KIND_LABELS: Record<TenantKind, string> = {
  grooming: 'Груминг',
  massage: 'Массаж',
  tattoo: 'Тату',
  tutoring: 'Репетиторство',
  auto: 'Автосервис',
  beauty: 'Красота',
  other: 'Другое',
};

const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

/** The tenant this master is currently managing, if any. */
export async function currentStaff(
  ctx: BotContext,
): Promise<{ tenant: TenantRow; staff: StaffRow } | null> {
  const telegramId = senderId(ctx);
  if (telegramId === null) return null;

  const memberships = await ctx.tenants.membershipsOf(telegramId);
  if (memberships.length === 0) return null;

  const preferred = ctx.session.staffTenantId;
  const chosen = memberships.find((m) => m.tenant.id === preferred) ?? memberships[0];
  if (!chosen) return null;
  ctx.session.staffTenantId = chosen.tenant.id;
  return chosen;
}

/* ------------------------------ registration ------------------------------ */

async function beginRegistration(ctx: BotContext): Promise<void> {
  ctx.session.registration = { step: 'title' };
  ctx.session.awaiting = { kind: 'reg_title' };
  await renderMenu(ctx, { text: texts.staff.askTitle, fresh: true });
}

async function askKind(ctx: BotContext): Promise<void> {
  const rows = grid(
    TENANT_KINDS.map((k) => button(KIND_LABELS[k], { a: 'set', k: 'kind', v: k })),
    2,
  );
  await renderMenu(ctx, { text: texts.staff.askKind, keyboard: rows });
}

/** A short list of zones that covers most of our users, plus free-text search. */
const COMMON_TIMEZONES = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Vladivostok',
  'Asia/Nicosia',
  'Asia/Almaty',
  'Asia/Tbilisi',
  'Europe/Belgrade',
];

async function askTimezone(ctx: BotContext): Promise<void> {
  ctx.session.awaiting = { kind: 'reg_timezone' };
  const rows = grid(
    COMMON_TIMEZONES.map((tz) =>
      button(tz.split('/')[1] ?? tz, { a: 'set', k: 'tz', v: tz.slice(0, 24) }),
    ),
    2,
  );
  await renderMenu(ctx, {
    text: `${texts.staff.askTimezone}\n\n${esc(texts.staff.askTimezoneSearch)}`,
    keyboard: rows,
  });
}

async function askFirstService(ctx: BotContext): Promise<void> {
  ctx.session.awaiting = { kind: 'reg_service' };
  await renderMenu(ctx, { text: texts.staff.askService });
}

async function askSchedule(ctx: BotContext): Promise<void> {
  const draft = ctx.session.registration;
  const selected = new Set(draft?.weekdays ?? [1, 2, 3, 4, 5]);
  const rows = grid(
    WEEKDAY_LABELS.map((label, index) =>
      button(selected.has(index) ? `${label} ✓` : label, { a: 'wh', w: index }),
    ),
    4,
  );
  rows.push([button(texts.common.done, { a: 'set', k: 'sched_done' })]);
  await renderMenu(ctx, { text: texts.staff.askSchedule, keyboard: rows });
}

/** Parses "Стрижка, 60, 3000" into a service draft. Price is optional. */
export function parseServiceLine(
  line: string,
): { name: string; durationMin: number; priceMinor: number | null } | null {
  const parts = line.split(',').map((p) => p.trim());
  const name = parts[0];
  const durationRaw = parts[1];
  if (!name || !durationRaw) return null;

  const durationMin = Number.parseInt(durationRaw, 10);
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 12 * 60) return null;

  const priceRaw = parts[2];
  if (priceRaw === undefined || priceRaw === '') return { name, durationMin, priceMinor: null };

  const major = Number.parseFloat(priceRaw.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(major) || major < 0) return null;
  // Money enters the system as an integer count of minor units, immediately.
  return { name, durationMin, priceMinor: Math.round(major * 100) };
}

/** Parses "09:00-18:00" into local wall-clock bounds. */
export function parseHoursLine(line: string): { startsLocal: string; endsLocal: string } | null {
  const match = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/.exec(line.trim());
  if (!match) return null;
  const [, start, end] = match;
  if (!start || !end) return null;
  try {
    if (parseLocalTime(start) >= parseLocalTime(end)) return null;
  } catch {
    return null;
  }
  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  return { startsLocal: pad(start), endsLocal: pad(end) };
}

async function finishRegistration(ctx: BotContext): Promise<void> {
  const draft = ctx.session.registration;
  const telegramId = senderId(ctx);
  if (!draft || telegramId === null) return;
  if (
    !draft.title ||
    !draft.kind ||
    !draft.timezone ||
    !draft.serviceName ||
    !draft.serviceDurationMin
  ) {
    return;
  }

  // A slug collision is astronomically unlikely but cheap to rule out.
  let slug = generateSlug();
  for (let i = 0; i < 5 && (await ctx.tenants.slugTaken(slug)); i++) slug = generateSlug();

  const tenant = await ctx.tenants.create({
    slug,
    title: draft.title,
    // The draft lives in a session row, so its `kind` is data from outside this
    // process: parse it rather than trusting the string.
    kind: tenantKindSchema.parse(draft.kind),
    timezone: draft.timezone,
    botId: ctx.deps.botRow.id,
  });

  const repo = ctx.tenantRepo(tenant.id);
  const staff = await repo.staff.create({ telegramId, name: displayName(ctx), role: 'owner' });
  const service = await repo.services.create({
    name: draft.serviceName,
    description: null,
    durationMin: draft.serviceDurationMin,
    bufferAfterMin: 0,
    priceMinor: draft.servicePriceMinor ?? null,
    currency: 'RUB',
    sortOrder: 0,
  });
  await repo.services.link(staff.id, service.id);

  const weekdays = draft.weekdays ?? [1, 2, 3, 4, 5];
  for (const weekday of weekdays) {
    await repo.schedule.setWeekday(staff.id, weekday, [
      { startsLocal: draft.startsLocal ?? '09:00', endsLocal: draft.endsLocal ?? '18:00' },
    ]);
  }

  ctx.session.registration = undefined;
  ctx.session.awaiting = undefined;
  ctx.session.staffTenantId = tenant.id;

  const link = startLink(ctx.deps.botRow.username, { kind: 'master', slug: tenant.slug });
  await renderMenu(ctx, {
    text: texts.staff.registered(esc(link)),
    keyboard: [[button(texts.common.menu, { a: 'menu', v: 'cabinet' })]],
    fresh: true,
  });
}

/* --------------------------------- cabinet -------------------------------- */

function cabinetKeyboard(): Keyboard {
  return [
    [
      button(texts.staff.menuToday, { a: 'menu', v: 'today' }),
      button(texts.staff.menuCalendar, { a: 'menu', v: 'cal' }),
    ],
    [
      button(texts.staff.menuServices, { a: 'menu', v: 'svcs' }),
      button(texts.staff.menuSchedule, { a: 'menu', v: 'sched' }),
    ],
    [
      button(texts.staff.menuClients, { a: 'menu', v: 'clients' }),
      button(texts.staff.menuStats, { a: 'menu', v: 'stats' }),
    ],
    [
      button(texts.staff.menuBroadcast, { a: 'menu', v: 'bc' }),
      button(texts.staff.menuSettings, { a: 'menu', v: 'set' }),
    ],
  ];
}

export async function showCabinet(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const { startMs, endMs } = monthBounds(ctx.now(), tenant.timezone);
  const used = await repo.appointments.countCreatedBetween(startMs, endMs);
  const quota = monthlyQuota(tenant.plan, used);

  const quotaLine =
    quota.limit === null ? '' : `Записей в этом месяце: ${quota.used} из ${quota.limit}`;

  await renderMenu(ctx, {
    text: [html`<b>${tenant.title}</b>`.value, esc(texts.staff.welcome), esc(quotaLine)]
      .filter(Boolean)
      .join('\n'),
    keyboard: cabinetKeyboard(),
  });
}

async function showToday(ctx: BotContext, tenant: TenantRow, dateIso?: string): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const zone = tenant.timezone;
  const day = dateIso
    ? DateTime.fromISO(dateIso, { zone })
    : DateTime.fromMillis(ctx.now(), { zone });
  const from = day.startOf('day');
  const to = from.plus({ days: 1 });

  const appointments = await repo.appointments.listBetween(from.toMillis(), to.toMillis());
  const services = new Map<string, ServiceRow>();
  const lines: string[] = [
    esc(texts.staff.todayHeader(formatDayHeading(from), appointments.length)),
  ];
  const rows: Keyboard = [];

  for (const appt of appointments) {
    let service = services.get(appt.serviceId);
    if (!service) {
      const found = await repo.services.byId(appt.serviceId);
      if (found) {
        service = found;
        services.set(appt.serviceId, found);
      }
    }
    const client = await repo.clients.byId(appt.clientId);
    const label = texts.staff.appointmentLine(
      formatTime(appt.startsAt, zone),
      client?.name ?? '',
      service?.name ?? '',
    );
    lines.push(esc(label));
    rows.push([button(label.slice(0, 60), { a: 'appt', o: 'show', id: appt.id })]);
  }

  if (appointments.length === 0) lines.push(esc(texts.staff.todayEmpty));

  rows.push([
    button('←', { a: 'day_nav', d: from.minus({ days: 1 }).toFormat('yyyy-MM-dd') }),
    button('→', { a: 'day_nav', d: to.toFormat('yyyy-MM-dd') }),
  ]);
  rows.push([button(texts.common.back, { a: 'menu', v: 'cabinet' })]);

  await renderMenu(ctx, { text: lines.join('\n'), keyboard: rows });
}

async function showStaffAppointment(ctx: BotContext, tenant: TenantRow, id: string): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const appointment = await repo.appointments.byId(id);
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

  const rows: Keyboard = [];
  if (appointment.status === 'confirmed' || appointment.status === 'pending') {
    rows.push([
      button(texts.client.reschedule, { a: 'appt', o: 'resched', id: appointment.id }),
      button(texts.client.cancelBooking, { a: 'appt', o: 'cancel', id: appointment.id }),
    ]);
    rows.push([
      button(texts.staff.markCame, { a: 'appt', o: 'came', id: appointment.id }),
      button(texts.staff.markNoShow, { a: 'appt', o: 'noshow', id: appointment.id }),
    ]);
  }
  rows.push([button(texts.staff.clientHistory, { a: 'cli', id: client.id })]);
  if (client.telegramId === null) {
    // Say it plainly, or the master concludes the reminders are broken.
    const link = startLink(ctx.deps.botRow.username, { kind: 'ref', ref: appointment.ref });
    rows.push([
      urlButton(texts.staff.sendInvite, `https://t.me/share/url?url=${encodeURIComponent(link)}`),
    ]);
  }
  rows.push([button(texts.common.back, { a: 'menu', v: 'today' })]);

  await renderMenu(ctx, {
    text: staffAppointmentCard({ tenant, appointment, service, staff, client }),
    keyboard: rows,
  });
}

/* ------------------------------- statistics ------------------------------- */

const STATS_WINDOW_DAYS = 30;

export async function showStats(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const nowMs = ctx.now();
  const fromMs = nowMs - STATS_WINDOW_DAYS * 86_400_000;

  const [rows, delivery] = await Promise.all([
    repo.stats.rows(fromMs, nowMs),
    repo.reminders.deliveryStats(fromMs, nowMs),
  ]);
  const stats = computeStats(rows, delivery);
  const currency = 'RUB' as Currency;

  const body = [
    esc(texts.staff.statsHeader(STATS_WINDOW_DAYS)),
    esc(
      texts.staff.statsBody({
        total: stats.total,
        completed: stats.completed,
        cancelled: stats.cancelled,
        noShow: stats.noShow,
        noShowRate: formatPercent(stats.noShowRate),
        revenue: formatMoney(stats.revenueMinor, currency),
        newClients: stats.newClients,
        returning: stats.returningClients,
      }),
    ),
    '',
    // The line that justifies the subscription. Never drop it.
    esc(texts.staff.statsDelivery(stats.remindersSent, stats.remindersConfirmed)),
    esc(
      texts.staff.statsSaved(
        formatMoney(estimatedSavedMinor(stats, averageTicketMinor(stats)), currency),
      ),
    ),
  ];

  if (stats.topServices.length > 0) {
    body.push('', esc(texts.staff.statsTopServices));
    for (const s of stats.topServices) body.push(html`${s.serviceName} — ${s.count}`.value);
  }

  await renderMenu(ctx, {
    text: body.join('\n'),
    keyboard: [[button(texts.common.back, { a: 'menu', v: 'cabinet' })]],
  });
}

/* --------------------------------- services ------------------------------- */

async function showServices(ctx: BotContext, tenant: TenantRow, page = 0): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const all = await repo.services.list(true);
  const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows: Keyboard = slice.map((s) => {
    // A button label is plain text, not HTML, so the service name goes in raw —
    // escaping it here would show a master "Стрижка &lt;люкс&gt;" on the button.
    const label = texts.client.serviceLine(s.name, s.durationMin, s.priceMinor, s.currency);
    const prefix = s.isActive ? '' : '· ';
    return [button((prefix + label).slice(0, 60), { a: 'svc_edit', id: s.id, f: 'toggle' })];
  });
  const pagination = paginationRow('svcs', page, (page + 1) * PAGE_SIZE < all.length);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([button(texts.staff.addService, { a: 'set', k: 'svc_new' })]);
  rows.push([button(texts.common.back, { a: 'menu', v: 'cabinet' })]);

  await renderMenu(ctx, {
    text: all.length === 0 ? texts.staff.servicesEmpty : `<b>${esc(texts.staff.menuServices)}</b>`,
    keyboard: rows,
  });
}

/* ---------------------------------- clients ------------------------------- */

async function showClients(
  ctx: BotContext,
  tenant: TenantRow,
  page = 0,
  query = '',
): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const clients = await repo.clients.search(query, PAGE_SIZE + 1, page * PAGE_SIZE);
  const hasMore = clients.length > PAGE_SIZE;
  const slice = clients.slice(0, PAGE_SIZE);

  const rows: Keyboard = slice.map((c) => [button(c.name.slice(0, 60), { a: 'cli', id: c.id })]);
  const pagination = paginationRow('clients', page, hasMore);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([button(texts.common.back, { a: 'menu', v: 'cabinet' })]);

  await renderMenu(ctx, {
    text: slice.length === 0 ? texts.staff.clientsEmpty : `<b>${esc(texts.staff.menuClients)}</b>`,
    keyboard: rows,
  });
}

async function showClientCard(ctx: BotContext, tenant: TenantRow, clientId: string): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const client = await repo.clients.byId(clientId);
  if (!client) {
    await ctx.answerCallbackQuery({ text: texts.errors.notFound, show_alert: true });
    return;
  }

  const history = await repo.appointments.forClient(clientId, 20, false, ctx.now());
  const completed = history.filter((a) => a.status === 'completed');
  const noShows = history.filter((a) => a.status === 'no_show');
  const spent = completed.reduce((sum, a) => sum + (a.priceMinor ?? 0), 0);

  const lines = [
    texts.staff.clientCard(
      esc(client.name),
      completed.length,
      esc(formatMoney(spent)),
      noShows.length,
    ),
  ];
  if (client.phone) lines.push(html`${client.phone}`.value);
  if (client.notes) lines.push(html`${texts.staff.clientNote}: ${client.notes}`.value);
  if (client.telegramId === null) lines.push(esc(texts.staff.manualNoReminders));

  const recent = history.slice(0, 5);
  if (recent.length > 0) {
    lines.push('');
    for (const appt of recent) {
      lines.push(esc(`${formatWhen(appt.startsAt, tenant.timezone)} — ${statusLabel(appt)}`));
    }
  }

  await renderMenu(ctx, {
    text: lines.join('\n'),
    keyboard: [
      [button(texts.staff.clientNote, { a: 'set', k: 'cli_note', v: clientId.slice(0, 8) })],
      [button(texts.common.back, { a: 'menu', v: 'clients' })],
    ],
  });
}

function statusLabel(appointment: AppointmentRow): string {
  switch (appointment.status) {
    case 'completed':
      return 'выполнено';
    case 'no_show':
      return 'не пришёл';
    case 'cancelled_by_client':
      return 'отменил клиент';
    case 'cancelled_by_staff':
      return 'отменил мастер';
    case 'expired':
      return 'не подтверждено';
    case 'rescheduled':
      return 'перенесено';
    default:
      return 'запланировано';
  }
}

/* --------------------------------- settings ------------------------------- */

async function showSettings(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const link = startLink(ctx.deps.botRow.username, { kind: 'master', slug: tenant.slug });
  const plan = tenant.plan;

  const rows: Keyboard = [
    [
      button(
        `${texts.staff.settingsAutoConfirm}: ${tenant.autoConfirm ? texts.common.yes : texts.common.no}`,
        { a: 'set', k: 'autoconf' },
      ),
    ],
    [
      button(`${texts.staff.settingsCancelWindow}: ${tenant.cancelWindowHours} ч`, {
        a: 'set',
        k: 'cancelwin',
      }),
    ],
    [
      button(
        `${texts.staff.settingsReminders}: ${tenant.reminderOffsetsMin.map(formatOffset).join(', ')}`,
        { a: 'set', k: 'reminders' },
      ),
    ],
  ];
  if (hasFeature(plan, 'dedicated_bot')) {
    rows.push([button(texts.staff.settingsOwnBot, { a: 'set', k: 'ownbot' })]);
  } else {
    rows.push([button(texts.plans.upgrade, { a: 'set', k: 'upgrade' })]);
  }
  rows.push([button(texts.common.back, { a: 'menu', v: 'cabinet' })]);

  await renderMenu(ctx, {
    text: [
      `<b>${esc(texts.staff.menuSettings)}</b>`,
      `${esc(texts.staff.settingsLink)}:`,
      esc(link),
      '',
      esc(texts.plans.pricing),
    ].join('\n'),
    keyboard: rows,
  });
}

function formatOffset(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`;
}

/* --------------------------------- wiring --------------------------------- */

/**
 * The button-driven steps of registration, which run before the master has a
 * tenant at all. Returns true when the tap belonged to the wizard.
 */
async function handleRegistrationStep(ctx: BotContext, data: CallbackData): Promise<boolean> {
  if (data.a === 'set' && data.k === 'register') {
    await ctx.answerCallbackQuery();
    await beginRegistration(ctx);
    return true;
  }

  const draft = ctx.session.registration;
  if (!draft) return false;

  if (data.a === 'set' && data.k === 'kind') {
    ctx.session.registration = { ...draft, kind: data.v ?? 'other', step: 'timezone' };
    await ctx.answerCallbackQuery();
    await askTimezone(ctx);
    return true;
  }

  if (data.a === 'set' && data.k === 'tz') {
    // The button carries a truncated zone name; match it back to the full one.
    const zone = COMMON_TIMEZONES.find((tz) => tz.startsWith(data.v ?? '')) ?? 'Europe/Moscow';
    ctx.session.registration = { ...draft, timezone: zone, step: 'service' };
    await ctx.answerCallbackQuery();
    await askFirstService(ctx);
    return true;
  }

  if (data.a === 'wh') {
    const weekdays = new Set(draft.weekdays ?? [1, 2, 3, 4, 5]);
    if (weekdays.has(data.w)) weekdays.delete(data.w);
    else weekdays.add(data.w);
    ctx.session.registration = { ...draft, weekdays: [...weekdays].sort() };
    await ctx.answerCallbackQuery();
    await askSchedule(ctx);
    return true;
  }

  if (data.a === 'set' && data.k === 'sched_done') {
    ctx.session.awaiting = { kind: 'reg_hours' };
    await ctx.answerCallbackQuery();
    await renderMenu(ctx, { text: texts.staff.askScheduleHours(texts.staff.scheduleHeader) });
    return true;
  }

  return false;
}

/** The eight cabinet destinations, split out so the dispatcher stays flat. */
async function showCabinetSection(
  ctx: BotContext,
  tenant: TenantRow,
  section: string,
  next: NextFunction,
): Promise<void> {
  switch (section) {
    case 'cabinet':
      return showCabinet(ctx, tenant);
    case 'today':
      return showToday(ctx, tenant);
    case 'svcs':
      return showServices(ctx, tenant);
    case 'clients':
      return showClients(ctx, tenant);
    case 'stats':
      return showStats(ctx, tenant);
    case 'set':
      return showSettings(ctx, tenant);
    default:
      return next();
  }
}

/** What a master may do to an appointment on their own calendar. */
async function handleStaffAppointmentAction(
  ctx: BotContext,
  tenant: TenantRow,
  action: 'show' | 'cancel' | 'resched' | 'confirm' | 'noshow' | 'came',
  appointmentId: string,
  next: NextFunction,
): Promise<void> {
  const deps = { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() };

  switch (action) {
    case 'show':
      await ctx.answerCallbackQuery();
      return showStaffAppointment(ctx, tenant, appointmentId);

    case 'came':
    case 'noshow': {
      // The verdict that feeds the product's headline metric.
      await recordOutcome(deps, {
        tenant,
        appointmentId,
        outcome: action === 'came' ? 'completed' : 'no_show',
      });
      await ctx.answerCallbackQuery({ text: texts.common.done });
      return showStaffAppointment(ctx, tenant, appointmentId);
    }

    case 'cancel': {
      // A master's cancellation is never bound by the client's cancel window.
      await cancelBooking(deps, { tenant, appointmentId, by: 'staff' });
      await ctx.answerCallbackQuery({ text: texts.client.cancelled });
      return showToday(ctx, tenant);
    }

    default:
      return next();
  }
}

/** Settings toggles. Each one re-reads the tenant so the screen shows the truth. */
async function handleSetting(
  ctx: BotContext,
  tenant: TenantRow,
  key: string,
  value: string | undefined,
  next: NextFunction,
): Promise<void> {
  async function redrawSettings(): Promise<void> {
    const updated = await ctx.tenants.byId(tenant.id);
    if (updated) await showSettings(ctx, updated);
  }

  switch (key) {
    case 'autoconf':
      await ctx.tenants.update(tenant.id, { autoConfirm: !tenant.autoConfirm });
      await ctx.answerCallbackQuery();
      return redrawSettings();

    case 'cancelwin': {
      // Cycles 2 -> 4 -> 8 -> 16 -> 2 hours, which covers every sensible choice
      // without a keyboard of its own.
      const hours = tenant.cancelWindowHours >= 24 ? 2 : tenant.cancelWindowHours * 2;
      await ctx.tenants.update(tenant.id, { cancelWindowHours: hours });
      await ctx.answerCallbackQuery();
      return redrawSettings();
    }

    case 'upgrade':
      await requestUpgrade(ctx, tenant);
      await ctx.answerCallbackQuery({ text: texts.plans.requestSent, show_alert: true });
      return;

    case 'cli_note':
      ctx.session.awaiting = { kind: 'client_note', context: value ?? '' };
      await ctx.answerCallbackQuery();
      await ctx.reply(texts.staff.clientNote);
      return;

    default:
      return next();
  }
}

export function registerStaffFlow(composer: Composer<BotContext>): void {
  composer.command('start', async (ctx, next) => {
    // A deep-link /start belongs to the client flow.
    if (typeof ctx.match === 'string' && ctx.match.length > 0) return next();

    const membership = await currentStaff(ctx);
    if (membership) return showCabinet(ctx, membership.tenant);

    await renderMenu(ctx, {
      text: texts.staff.registerPrompt,
      keyboard: [[button(texts.staff.registerStart, { a: 'set', k: 'register' })]],
      fresh: true,
    });
  });

  /* free-text steps */
  composer.on('message:text', async (ctx, next) => {
    const awaiting = ctx.session.awaiting;
    if (!awaiting) return next();
    const text = ctx.message.text.trim();

    switch (awaiting.kind) {
      case 'reg_title': {
        ctx.session.registration = {
          ...(ctx.session.registration ?? { step: 'title' }),
          title: text.slice(0, 120),
          step: 'kind',
        };
        ctx.session.awaiting = undefined;
        return askKind(ctx);
      }
      case 'reg_timezone': {
        // Free-text search across the IANA list, so a master can type "Самара".
        const match = findTimezone(text);
        if (!match) {
          await ctx.reply(texts.staff.askTimezoneSearch);
          return;
        }
        ctx.session.registration = {
          ...(ctx.session.registration ?? { step: 'timezone' }),
          timezone: match,
          step: 'service',
        };
        ctx.session.awaiting = undefined;
        return askFirstService(ctx);
      }
      case 'reg_service': {
        const parsed = parseServiceLine(text);
        if (!parsed) {
          await ctx.reply(texts.staff.askService);
          return;
        }
        ctx.session.registration = {
          ...(ctx.session.registration ?? { step: 'service' }),
          serviceName: parsed.name,
          serviceDurationMin: parsed.durationMin,
          servicePriceMinor: parsed.priceMinor,
          step: 'schedule',
        };
        ctx.session.awaiting = undefined;
        return askSchedule(ctx);
      }
      case 'reg_hours': {
        const hours = parseHoursLine(text);
        if (!hours) {
          await ctx.reply(texts.staff.askScheduleHours(''));
          return;
        }
        ctx.session.registration = {
          ...(ctx.session.registration ?? { step: 'schedule' }),
          ...hours,
        };
        ctx.session.awaiting = undefined;
        return finishRegistration(ctx);
      }
      case 'client_note': {
        const membership = await currentStaff(ctx);
        const clientId = awaiting.context;
        if (!membership || !clientId) return next();
        await ctx
          .tenantRepo(membership.tenant.id)
          .clients.update(clientId, { notes: text.slice(0, 1000) });
        ctx.session.awaiting = undefined;
        return showClientCard(ctx, membership.tenant, clientId);
      }
      case 'client_search': {
        const membership = await currentStaff(ctx);
        if (!membership) return next();
        ctx.session.awaiting = undefined;
        return showClients(ctx, membership.tenant, 0, text);
      }
      default:
        return next();
    }
  });

  composer.on('callback_query:data', async (ctx, next) => {
    const data = decodeCallback(ctx.callbackQuery.data);
    if (!data) return next();

    // Registration happens before a tenant exists, so it is checked first.
    if (await handleRegistrationStep(ctx, data)) return;

    const membership = await currentStaff(ctx);
    if (!membership) return next();
    const { tenant } = membership;

    switch (data.a) {
      case 'menu':
        await ctx.answerCallbackQuery();
        return showCabinetSection(ctx, tenant, data.v, next);

      case 'day_nav':
        await ctx.answerCallbackQuery();
        return showToday(ctx, tenant, data.d);

      case 'page':
        await ctx.answerCallbackQuery();
        if (data.s === 'svcs') return showServices(ctx, tenant, data.p);
        if (data.s === 'clients') return showClients(ctx, tenant, data.p);
        return next();

      case 'cli':
        await ctx.answerCallbackQuery();
        return showClientCard(ctx, tenant, data.id);

      case 'appt':
        return handleStaffAppointmentAction(ctx, tenant, data.o, data.id, next);

      case 'set':
        return handleSetting(ctx, tenant, data.k, data.v, next);

      default:
        return next();
    }
  });
}

/** "Хочу Pro" sends a lead to the admin chat; billing happens outside the product. */
async function requestUpgrade(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const adminChat = ctx.deps.env.ADMIN_CHAT_ID;
  if (!adminChat) return;
  await ctx.deps.queue.enqueue({
    kind: 'send_message',
    payload: {
      kind: 'send_message',
      botId: ctx.deps.botRow.id,
      chatId: adminChat,
      text: html`Заявка на Pro: ${tenant.title} (${tenant.slug}), tg ${String(ctx.from?.id ?? '')}`
        .value,
      disablePreview: true,
      marketing: false,
      tenantId: tenant.id,
    },
    priority: 10,
  });
}

/** Matches a typed city or zone against the full IANA list. */
export function findTimezone(query: string): string | null {
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_');
  if (needle === '') return null;

  const zones = Intl.supportedValuesOf('timeZone');
  const exact = zones.find((z) => z.toLowerCase() === needle);
  if (exact) return exact;

  const byCity = zones.find((z) => (z.split('/').pop() ?? '').toLowerCase() === needle);
  if (byCity) return byCity;

  return zones.find((z) => z.toLowerCase().includes(needle)) ?? null;
}

export { isValidSlug };
