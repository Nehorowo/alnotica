/**
 * Telegram webhook.
 *
 * The contract with Telegram is simple and unforgiving: answer 200 within
 * milliseconds or the delivery rate drops and the update is retried. So this
 * handler does exactly two things — authenticate the request and write the update
 * to a table — and hands everything else to the queue.
 *
 * It also answers 200 during a migration window. Telegram only retries non-200
 * responses, and a retried update we can no longer identify is a lost booking.
 */
import { secretMatches } from '@alnotica/core';
import { PRIORITY, type ProcessUpdatePayload } from '@alnotica/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import type { App } from '../lib/server.js';

/** Only the envelope is validated here; grammY parses the body in the worker. */
const updateEnvelopeSchema = z.object({ update_id: z.number().int() }).passthrough();

const paramsSchema = z.object({ botHash: z.string().min(8).max(64) });

export function registerWebhookRoutes(app: App, ctx: AppContext): void {
  app.post('/tg/:botHash', async (request, reply) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    const provided = Array.isArray(header) ? header[0] : header;

    // Constant-time comparison, and an empty body so a prober learns nothing.
    if (!secretMatches(provided, ctx.env.WEBHOOK_SECRET)) {
      ctx.log.warn({ path: request.url }, 'webhook rejected: bad secret token');
      return reply.code(401).send();
    }

    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    const bot = await ctx.bots.byHash(params.data.botHash);
    if (!bot || !bot.isActive) {
      ctx.log.warn({ botHash: params.data.botHash }, 'webhook for unknown bot');
      // 200, not 404: a 404 makes Telegram retry forever for a bot we deleted.
      return reply.code(200).send();
    }

    const envelope = updateEnvelopeSchema.safeParse(request.body);
    if (!envelope.success) {
      ctx.log.warn({ botId: bot.id }, 'webhook body is not an update');
      return reply.code(200).send();
    }

    const { row, duplicate } = await ctx.updates.record(
      bot.id,
      envelope.data.update_id,
      request.body,
    );

    if (duplicate || !row) {
      // Telegram retried an update we already have. Silently accept it.
      ctx.log.debug(
        { botId: bot.id, updateId: envelope.data.update_id },
        'duplicate update ignored',
      );
      return reply.code(200).send();
    }

    const payload: ProcessUpdatePayload = {
      kind: 'process_update',
      botId: bot.id,
      tgUpdateRowId: String(row.id),
    };
    await ctx.jobs.enqueue({
      kind: 'process_update',
      payload,
      priority: PRIORITY.update,
      dedupeKey: `update:${bot.id}:${envelope.data.update_id}`,
    });

    return reply.code(200).send();
  });
}
