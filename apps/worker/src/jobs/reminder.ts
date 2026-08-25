/**
 * Reminders — the feature the whole product is sold on.
 *
 * Two guards matter here. First, the appointment is re-read at send time: a job
 * may have survived a cancellation through some path we have not thought of, and
 * this is the last place to notice. Second, delivery is recorded, because
 * "reminders delivered: N, confirmed: M" is the line that justifies the invoice.
 */
import { sendMessage } from '@alnotica/core';
import { forTenant } from '@alnotica/db';
import { type ReminderPayload, encodeCallback, esc, isBlockingStatus } from '@alnotica/shared';
import { formatWhen } from '../bot/format.js';
import { texts } from '../bot/texts.js';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';

export async function handleReminder(ctx: JobContext, payload: ReminderPayload): Promise<void> {
  const found = await findAppointment(ctx, payload.appointmentId);
  if (!found) throw new JobSkipped('appointment is gone');
  const { tenant, repo } = found;
  const appointment = found.appointment;

  // The belt to `cancelByKey`'s braces: a cancelled booking never reminds.
  if (!isBlockingStatus(appointment.status as 'pending' | 'confirmed')) {
    throw new JobSkipped(`appointment is ${appointment.status}`);
  }

  const [service, staff, client] = await Promise.all([
    repo.services.byId(appointment.serviceId),
    repo.staff.byId(appointment.staffId),
    repo.clients.byId(appointment.clientId),
  ]);
  if (!service || !staff || !client) throw new JobSkipped('appointment is incomplete');

  // A hand-entered client never pressed /start, so the bot may not write to them.
  if (client.telegramId === null || client.isBlocked || client.consentAt === null) {
    throw new JobSkipped('client is not reachable');
  }

  const resolved = await ctx.registry.byId(tenant.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  const when = formatWhen(appointment.startsAt, tenant.timezone);
  const hours = Math.round(payload.offsetMin / 60);
  const text =
    payload.offsetMin >= 1440
      ? texts.reminders.dayBefore(
          esc(service.name),
          esc(when),
          esc(staff.name),
          tenant.address ? esc(tenant.address) : null,
        )
      : texts.reminders.hoursBefore(
          hours,
          esc(service.name),
          esc(when),
          tenant.address ? esc(tenant.address) : null,
        );

  const outcome = await sendMessage(resolved.bot.api, {
    chatId: client.telegramId.toString(),
    text,
    keyboard: [
      [
        {
          text: texts.reminders.confirmButton,
          data: encodeCallback({ a: 'appt', o: 'confirm', id: appointment.id }),
        },
      ],
      [
        {
          text: texts.reminders.rescheduleButton,
          data: encodeCallback({ a: 'appt', o: 'resched', id: appointment.id }),
        },
        {
          text: texts.reminders.cancelButton,
          data: encodeCallback({ a: 'appt', o: 'cancel', id: appointment.id }),
        },
      ],
    ],
  });

  switch (outcome.kind) {
    case 'sent':
    case 'edited':
    case 'unchanged':
      await repo.reminders.record({
        appointmentId: appointment.id,
        offsetMin: payload.offsetMin,
        delivered: true,
        sentAt: new Date(ctx.now()),
      });
      return;

    case 'blocked': {
      await repo.clients.markBlocked(client.id);
      await repo.reminders.record({
        appointmentId: appointment.id,
        offsetMin: payload.offsetMin,
        delivered: false,
        error: 'blocked',
        sentAt: new Date(ctx.now()),
      });
      // The master must be told, or they will assume the client was reminded.
      await ctx.queue.enqueue({
        kind: 'send_message',
        payload: {
          kind: 'send_message',
          botId: tenant.botId,
          chatId: staff.telegramId.toString(),
          text: `${esc(client.name)} — ${esc(texts.staff.clientBlockedBot)}`,
          disablePreview: true,
          marketing: false,
          tenantId: tenant.id,
        },
        priority: 10,
        dedupeKey: `blocked_notice:${appointment.id}`,
      });
      throw new JobSkipped('client blocked the bot');
    }

    case 'retry_later':
      throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
  }
}

/**
 * Resolves an appointment id from a queue payload to its tenant in one query.
 * The job table stores appointment ids because that is what the booking flow
 * knows; the join back to the tenant is indexed on the primary key.
 */
export async function findAppointment(ctx: JobContext, appointmentId: string) {
  const found = await ctx.tenants.byAppointmentId(appointmentId);
  if (!found) return null;
  return {
    tenant: found.tenant,
    appointment: found.appointment,
    repo: forTenant(ctx.db, found.tenant.id),
  };
}
