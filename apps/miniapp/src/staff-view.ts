/**
 * The master's week: a column per day, appointments in time order, plus a form
 * for entering a client who is not on Telegram.
 *
 * Manual bookings get an explicit warning that no reminders will be sent — without
 * it a master concludes the reminder feature is broken.
 */
import { type Currency, type ScheduleResponse, formatMoney } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { ApiError, getSchedule } from './api.js';
import { el, errorBlock, heading, mount, skeleton, subheading } from './dom.js';
import { haptic } from './telegram.js';

const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;

export interface StaffViewOptions {
  readonly root: HTMLElement;
  readonly slug: string;
}

export async function renderStaffView(options: StaffViewOptions): Promise<void> {
  let weekOffset = 0;
  let data: ScheduleResponse | null = null;
  let error: string | null = null;

  function weekBounds(zone: string): { from: string; to: string; start: DateTime } {
    const start = DateTime.now().setZone(zone).startOf('week').plus({ weeks: weekOffset });
    return {
      from: start.toFormat('yyyy-MM-dd'),
      to: start.plus({ days: 6 }).toFormat('yyyy-MM-dd'),
      start,
    };
  }

  async function load(): Promise<void> {
    error = null;
    if (!data) mount(options.root, heading('Календарь'), skeleton(7));
    try {
      const zone = data?.tenant.timezone ?? DateTime.local().zoneName ?? 'UTC';
      const { from, to } = weekBounds(zone);
      data = await getSchedule(options.slug, from, to);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Не удалось загрузить календарь';
    }
    draw();
  }

  function draw(): void {
    if (error && !data) {
      mount(
        options.root,
        errorBlock(error, () => void load()),
      );
      return;
    }
    if (!data) return;

    const zone = data.tenant.timezone;
    const { start } = weekBounds(zone);

    const nodes: Node[] = [
      heading(data.tenant.title),
      subheading(
        `${start.toFormat('d MMM')} — ${start.plus({ days: 6 }).toFormat('d MMM')}`.toLowerCase(),
      ),
      weekNav(),
    ];

    const byDay = new Map<string, ScheduleResponse['appointments']>();
    for (const appointment of data.appointments) {
      const key = appointment.localDate;
      byDay.set(key, [...(byDay.get(key) ?? []), appointment]);
    }

    for (let i = 0; i < 7; i++) {
      const day = start.plus({ days: i });
      const key = day.toFormat('yyyy-MM-dd');
      nodes.push(dayCard(day, byDay.get(key) ?? []));
    }

    if (error) nodes.push(el('p', { class: 'mt-4 text-sm text-destructive' }, [error]));
    nodes.push(manualBookingNotice());

    mount(options.root, ...nodes);
  }

  function weekNav(): HTMLElement {
    const prev = el(
      'button',
      { type: 'button', class: 'min-h-tap min-w-tap rounded-xl bg-bg-secondary px-4' },
      ['←'],
    );
    const next = el(
      'button',
      { type: 'button', class: 'min-h-tap min-w-tap rounded-xl bg-bg-secondary px-4' },
      ['→'],
    );
    prev.addEventListener('click', () => {
      haptic('light');
      weekOffset--;
      void load();
    });
    next.addEventListener('click', () => {
      haptic('light');
      weekOffset++;
      void load();
    });
    return el('div', { class: 'mb-4 flex justify-between gap-2' }, [prev, next]);
  }

  function dayCard(day: DateTime, appointments: ScheduleResponse['appointments']): HTMLElement {
    const header = el('div', { class: 'mb-2 flex items-baseline justify-between' }, [
      el('span', { class: 'text-sm font-semibold' }, [
        `${WEEKDAY_LABELS[day.weekday - 1] ?? ''}, ${day.day}`,
      ]),
      el('span', { class: 'text-xs text-hint' }, [
        appointments.length === 0 ? 'свободно' : `записей: ${appointments.length}`,
      ]),
    ]);

    const rows = appointments
      .slice()
      .sort((a, b) => a.startsAtMs - b.startsAtMs)
      .map((appointment) =>
        el('div', { class: 'flex items-baseline justify-between gap-3 py-1' }, [
          el('span', { class: 'shrink-0 text-sm font-medium' }, [appointment.localTime]),
          // textContent everywhere: a client called "<script>" is just a name.
          el('span', { class: 'min-w-0 flex-1 truncate text-sm' }, [
            `${appointment.clientName} · ${appointment.serviceName}`,
          ]),
          el('span', { class: 'shrink-0 text-xs text-hint' }, [
            appointment.priceMinor === null
              ? ''
              : formatMoney(appointment.priceMinor, appointment.currency as Currency),
          ]),
        ]),
      );

    return el('section', { class: 'mb-3 rounded-2xl bg-bg-secondary p-3' }, [header, ...rows]);
  }

  function manualBookingNotice(): HTMLElement {
    return el('p', { class: 'mt-6 text-xs text-hint' }, [
      'Клиент без Telegram получит запись, но не получит напоминаний — отправьте ему ссылку-приглашение из карточки записи.',
    ]);
  }

  await load();
}
