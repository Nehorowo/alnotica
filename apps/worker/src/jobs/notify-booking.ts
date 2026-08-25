/**
 * Tells the master that a booking was made or cancelled.
 *
 * The API enqueues this with nothing but an appointment id and an event name:
 * every user-visible string in the product lives in `texts.ts`, and having the
 * HTTP process compose prose would put a second copy of the wording somewhere
 * nobody thinks to update.
 */
import { sendMessage } from '@alnotica/core';
import { type NotifyBookingPayload, encodeCallback, esc, html } from '@alnotica/shared';
import { formatWhen } from '../bot/format.js';
import { formatPrice } from '../bot/format.js';
import { texts } from '../bot/texts.js';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';
import { findAppointment } from './reminder.js';

export async function handleNotifyBooking(
  ctx: JobContext,
  payload: NotifyBookingPayload,
): Promise<void> {
  const found = await findAppointment(ctx, payload.appointmentId);
  if (!found) throw new JobSkipped('appointment is gone');
  const { tenant, repo, appointment } = found;

  const [service, staff, client] = await Promise.all([
    repo.services.byId(appointment.serviceId),
    repo.staff.byId(appointment.staffId),
    repo.clients.byId(appointment.clientId),
  ]);
  if (!service || !staff || !client) throw new JobSkipped('appointment is incomplete');

  const resolved = await ctx.registry.byId(tenant.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  const price = formatPrice(service.priceMinor, service.currency);
  const heading =
    payload.event === 'created' ? texts.staff.newBooking : texts.staff.bookingCancelled;

  const lines = [
    html`<b>${heading}</b>`.value,
    html`${client.name} · ${service.name}${price ? ` · ${price}` : ''}`.value,
    html`${formatWhen(appointment.startsAt, tenant.timezone)}`.value,
  ];
  // A client the master typed in never pressed /start, so no reminder can reach
  // them. Saying so here is what stops the master concluding we are broken.
  if (payload.event === 'created' && client.telegramId === null) {
    lines.push(esc(texts.staff.manualNoReminders));
  }

  const outcome = await sendMessage(resolved.bot.api, {
    chatId: staff.telegramId.toString(),
    text: lines.join('\n'),
    // A cancellation leaves a hole in the day; one tap offers it to lapsed clients.
    ...(payload.event === 'cancelled'
      ? {
          keyboard: [
            [
              {
                text: texts.broadcast.windowOpenedButton,
                data: encodeCallback({ a: 'bc', o: 'window', id: appointment.id }),
              },
            ],
          ],
        }
      : {}),
  });

  if (outcome.kind === 'retry_later') {
    throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
  }
  if (outcome.kind === 'blocked') throw new JobSkipped('master is unreachable');
}
