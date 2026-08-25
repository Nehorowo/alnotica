/**
 * Message formatting. Everything here escapes its inputs: the master will
 * eventually name a service `Стрижка <люкс> & укладка`, and an unescaped
 * interpolation would break the HTML parse for every message that mentions it.
 */
import type { AppointmentRow, ClientRow, ServiceRow, StaffRow, TenantRow } from '@alnotica/db';
import { type Currency, type SafeHtml, esc, formatMoney, html, raw } from '@alnotica/shared';
import { DateTime } from 'luxon';

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

export function inZone(date: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(date, { zone: timezone });
}

/** "5 июня, ср, 14:30" — how a person reads a time, in the master's zone. */
export function formatWhen(date: Date, timezone: string): string {
  const dt = inZone(date, timezone);
  const month = MONTHS_GENITIVE[dt.month - 1] ?? '';
  const weekday = WEEKDAYS_SHORT[dt.weekday % 7] ?? '';
  return `${dt.day} ${month}, ${weekday}, ${dt.toFormat('HH:mm')}`;
}

export function formatDayHeading(date: DateTime): string {
  const month = MONTHS_GENITIVE[date.month - 1] ?? '';
  const weekday = WEEKDAYS_SHORT[date.weekday % 7] ?? '';
  return `${date.day} ${month}, ${weekday}`;
}

export function formatTime(date: Date, timezone: string): string {
  return inZone(date, timezone).toFormat('HH:mm');
}

export function formatPrice(priceMinor: number | null, currency: string): string | null {
  return priceMinor === null ? null : formatMoney(priceMinor, currency as Currency);
}

export interface AppointmentParts {
  readonly tenant: TenantRow;
  readonly appointment: AppointmentRow;
  readonly service: ServiceRow;
  readonly staff: StaffRow;
  readonly client: ClientRow;
}

/** The card a client sees for their own booking. */
export function clientAppointmentCard(parts: AppointmentParts): SafeHtml {
  const { tenant, appointment, service, staff } = parts;
  const price = formatPrice(appointment.priceMinor, service.currency);
  const lines: SafeHtml[] = [
    html`<b>${tenant.title}</b>`,
    html`${service.name}${price ? ` · ${price}` : ''}`,
    html`${formatWhen(appointment.startsAt, tenant.timezone)}`,
    html`Мастер: ${staff.name}`,
  ];
  if (tenant.address) lines.push(html`${tenant.address}`);
  return raw(lines.map((l) => l.value).join('\n'));
}

/** The card a master sees, which additionally names the client. */
export function staffAppointmentCard(parts: AppointmentParts): string {
  const { tenant, appointment, service, staff, client } = parts;
  const price = formatPrice(appointment.priceMinor, service.currency);
  return [
    `<b>${esc(formatWhen(appointment.startsAt, tenant.timezone))}</b>`,
    `${esc(client.name)}${client.phone ? ` · ${esc(client.phone)}` : ''}`,
    `${esc(service.name)}${price ? ` · ${esc(price)}` : ''}`,
    `Мастер: ${esc(staff.name)}`,
    appointment.comment ? `Комментарий: ${esc(appointment.comment)}` : '',
    client.telegramId === null ? 'Без Telegram — напоминания не приходят.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function joinBlocks(blocks: readonly (string | SafeHtml | null | undefined)[]): string {
  return blocks
    .filter((b): b is string | SafeHtml => b !== null && b !== undefined && String(b) !== '')
    .map((b) => String(b))
    .join('\n');
}
