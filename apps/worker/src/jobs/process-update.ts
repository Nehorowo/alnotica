/**
 * Runs one stored Telegram update through grammY.
 *
 * The HTTP process only writes the update and returns 200; everything the bot
 * actually does happens here, where taking a second is fine.
 */
import type { ProcessUpdatePayload } from '@alnotica/shared';
import type { Update } from 'grammy/types';
import { type JobContext, JobSkipped } from './context.js';

export async function handleProcessUpdate(
  ctx: JobContext,
  payload: ProcessUpdatePayload,
): Promise<void> {
  const rowId = Number(payload.tgUpdateRowId);
  const row = await ctx.updates.byId(rowId);
  if (!row) throw new JobSkipped('update row is gone');

  // Already handled: Telegram delivered it twice and the first pass won.
  if (row.processedAt) throw new JobSkipped('update already processed');

  const resolved = await ctx.registry.byId(payload.botId);
  if (!resolved) throw new JobSkipped('bot is gone');

  try {
    // The payload is JSON from Telegram; grammY does its own parsing of it.
    await resolved.bot.handleUpdate(row.payload as Update);
    await ctx.updates.markProcessed(rowId);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // Recorded on the row as well as on the job, so the admin panel can show what
    // an individual update did rather than only that a job failed.
    await ctx.updates.markProcessed(rowId, message.slice(0, 1000));
    throw error;
  }
}
