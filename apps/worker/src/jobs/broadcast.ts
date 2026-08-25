/**
 * Broadcast delivery.
 *
 * Runs in the queue's slow lane at the lowest priority, in chunks, so a mass send
 * can never delay a booking confirmation. Every message carries an unsubscribe
 * button; transactional reminders deliberately do not, because a reminder about
 * one's own appointment is a service message, not marketing.
 */
import { sendMessage } from '@alnotica/core';
import { forTenant } from '@alnotica/db';
import { type BroadcastChunkPayload, encodeCallback, esc } from '@alnotica/shared';
import { texts } from '../bot/texts.js';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';

export async function handleBroadcastChunk(
  ctx: JobContext,
  payload: BroadcastChunkPayload,
): Promise<void> {
  const found = await ctx.tenants.byBroadcastId(payload.broadcastId);
  if (!found) throw new JobSkipped('broadcast is gone');
  const { tenant, broadcast } = found;

  if (broadcast.status !== 'sending' && broadcast.status !== 'approved') {
    throw new JobSkipped(`broadcast is ${broadcast.status}`);
  }

  const repo = forTenant(ctx.db, tenant.id);
  const resolved = await ctx.registry.byId(tenant.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  let sent = 0;
  let failed = 0;

  for (const clientId of payload.clientIds) {
    const client = await repo.clients.byId(clientId);
    // Re-checked per recipient: someone may have opted out since the chunk was
    // planned, and sending to them anyway is exactly how a shared bot gets banned.
    if (
      !client ||
      client.telegramId === null ||
      client.isBlocked ||
      client.marketingOptOut ||
      client.consentAt === null
    ) {
      continue;
    }

    const outcome = await sendMessage(resolved.bot.api, {
      chatId: client.telegramId.toString(),
      text: broadcast.text,
      keyboard: [
        [{ text: texts.broadcast.unsubscribe, data: encodeCallback({ a: 'unsub', t: tenant.id }) }],
      ],
    });

    switch (outcome.kind) {
      case 'sent':
      case 'edited':
      case 'unchanged':
        sent++;
        break;
      case 'blocked':
        await repo.clients.markBlocked(client.id);
        failed++;
        break;
      case 'retry_later':
        // Record what did go out before handing the rest back to the queue.
        await repo.broadcasts.recordProgress(broadcast.id, sent, failed);
        throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
    }
  }

  await repo.broadcasts.recordProgress(broadcast.id, sent, failed);

  const refreshed = await repo.broadcasts.byId(broadcast.id);
  if (refreshed && refreshed.sent + refreshed.failed >= refreshed.total) {
    await repo.broadcasts.update(broadcast.id, { status: 'sent', finishedAt: new Date() });
    const owners = await repo.staff.list();
    for (const owner of owners) {
      if (owner.role !== 'owner') continue;
      await ctx.queue.enqueue({
        kind: 'send_message',
        payload: {
          kind: 'send_message',
          botId: tenant.botId,
          chatId: owner.telegramId.toString(),
          text: esc(texts.broadcast.report(refreshed.sent, refreshed.failed)),
          disablePreview: true,
          marketing: false,
          tenantId: tenant.id,
        },
        priority: 10,
        dedupeKey: `bc_report:${broadcast.id}`,
      });
    }
  }
}
