/**
 * "Did the client turn up?"
 *
 * Two hours after a visit ends the bot asks the master. This is the only source
 * of no-show data, and the no-show rate is the number the master is paying for —
 * so the question is scheduled at booking time and asked exactly once.
 */
import { sendMessage } from '@alnotica/core';
import { type AskNoShowPayload, encodeCallback, esc } from '@alnotica/shared';
import { formatTime } from '../bot/format.js';
import { texts } from '../bot/texts.js';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';
import { findAppointment } from './reminder.js';

export async function handleAskNoShow(ctx: JobContext, payload: AskNoShowPayload): Promise<void> {
  const found = await findAppointment(ctx, payload.appointmentId);
  if (!found) throw new JobSkipped('appointment is gone');
  const { tenant, repo, appointment } = found;

  // Only a visit that was still on the calendar deserves the question.
  if (appointment.status !== 'confirmed' && appointment.status !== 'pending') {
    throw new JobSkipped(`appointment is ${appointment.status}`);
  }

  const [service, staff, client] = await Promise.all([
    repo.services.byId(appointment.serviceId),
    repo.staff.byId(appointment.staffId),
    repo.clients.byId(appointment.clientId),
  ]);
  if (!service || !staff || !client) throw new JobSkipped('appointment is incomplete');

  const resolved = await ctx.registry.byId(tenant.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  const outcome = await sendMessage(resolved.bot.api, {
    chatId: staff.telegramId.toString(),
    text: esc(
      texts.staff.askNoShow(
        client.name,
        service.name,
        formatTime(appointment.startsAt, tenant.timezone),
      ),
    ),
    keyboard: [
      [
        {
          text: texts.staff.markCame,
          data: encodeCallback({ a: 'appt_ok', o: 'came', id: appointment.id }),
        },
        {
          text: texts.staff.markNoShow,
          data: encodeCallback({ a: 'appt_ok', o: 'noshow', id: appointment.id }),
        },
      ],
    ],
  });

  if (outcome.kind === 'retry_later') {
    throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
  }
  if (outcome.kind === 'blocked') throw new JobSkipped('master is unreachable');
}
