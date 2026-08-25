/**
 * The 20:00 digest: what tomorrow looks like, in the master's own time zone.
 */
import { sendMessage } from '@alnotica/core';
import { forTenant } from '@alnotica/db';
import { type DailyDigestPayload, esc } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { formatDayHeading, formatTime } from '../bot/format.js';
import { texts } from '../bot/texts.js';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';

export async function handleDailyDigest(
  ctx: JobContext,
  payload: DailyDigestPayload,
): Promise<void> {
  const tenant = await ctx.tenants.byId(payload.tenantId);
  if (!tenant || !tenant.isActive) throw new JobSkipped('tenant is gone');

  const repo = forTenant(ctx.db, tenant.id);
  const zone = tenant.timezone;
  const day = DateTime.fromISO(payload.targetDate, { zone });
  if (!day.isValid) throw new JobSkipped('bad target date');

  const appointments = await repo.appointments.listBetween(
    day.startOf('day').toMillis(),
    day.plus({ days: 1 }).startOf('day').toMillis(),
  );

  const lines: string[] = [];
  const heading = formatDayHeading(day);
  if (appointments.length === 0) {
    lines.push(esc(texts.staff.digestEmpty(heading)));
  } else {
    lines.push(texts.staff.digestHeader(esc(heading)));
    for (const appt of appointments) {
      const [service, client] = await Promise.all([
        repo.services.byId(appt.serviceId),
        repo.clients.byId(appt.clientId),
      ]);
      lines.push(
        esc(
          texts.staff.appointmentLine(
            formatTime(appt.startsAt, zone),
            client?.name ?? '',
            service?.name ?? '',
          ),
        ),
      );
    }
  }

  const resolved = await ctx.registry.byId(tenant.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  const staff = await repo.staff.list();
  for (const member of staff) {
    const outcome = await sendMessage(resolved.bot.api, {
      chatId: member.telegramId.toString(),
      text: lines.join('\n'),
    });
    if (outcome.kind === 'retry_later') {
      throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
    }
  }
}
