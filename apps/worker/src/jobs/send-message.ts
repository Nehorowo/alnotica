/**
 * Outbound messages.
 *
 * All Telegram traffic funnels through here so that rate limits, blocked users
 * and transient failures are handled in exactly one place.
 */
import { sendMessage } from '@alnotica/core';
import { forTenant } from '@alnotica/db';
import type { SendMessagePayload } from '@alnotica/shared';
import { type JobContext, JobRetryLater, JobSkipped } from './context.js';

export async function handleSendMessage(
  ctx: JobContext,
  payload: SendMessagePayload,
): Promise<void> {
  const resolved = await ctx.registry.byId(payload.botId);
  if (!resolved) throw new JobSkipped(`bot ${payload.botId} is gone`);

  const outcome = await sendMessage(resolved.bot.api, {
    chatId: payload.chatId,
    text: payload.text,
    ...(payload.keyboard ? { keyboard: payload.keyboard } : {}),
    ...(payload.editMessageId === undefined ? {} : { editMessageId: payload.editMessageId }),
    disablePreview: payload.disablePreview,
  });

  switch (outcome.kind) {
    case 'sent':
    case 'edited':
    case 'unchanged':
      return;

    case 'blocked': {
      // The user blocked the bot. Stop writing to them, but leave the booking
      // alone: they may well still turn up, and the master needs to know.
      if (payload.tenantId && payload.clientId) {
        await forTenant(ctx.db, payload.tenantId).clients.markBlocked(payload.clientId);
      }
      ctx.log.info(
        { chatId: payload.chatId, tenantId: payload.tenantId },
        'client blocked the bot',
      );
      throw new JobSkipped('client blocked the bot');
    }

    case 'retry_later':
      // A long `retry_after` goes back to the queue rather than parking a worker.
      throw new JobRetryLater('telegram asked us to wait', outcome.retryAfterSec);
  }
}
