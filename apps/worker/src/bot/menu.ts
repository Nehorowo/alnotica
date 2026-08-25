/**
 * Menu rendering.
 *
 * The menu is one message that gets edited in place. Sending a new message for
 * every tap turns the chat into a scrollback of dead menus, and Telegram's own
 * clients handle an edited message far better than a wall of new ones.
 */
import { type KeyboardButton, sendMessage } from '@alnotica/core';
import type { BotContext } from './context.js';

export interface RenderOptions {
  readonly text: string;
  readonly keyboard?: readonly (readonly KeyboardButton[])[];
  /** Force a new message even if a menu message is already on screen. */
  readonly fresh?: boolean;
}

export async function renderMenu(ctx: BotContext, options: RenderOptions): Promise<void> {
  const chat = ctx.chat?.id ?? ctx.from?.id;
  if (chat === undefined) return;

  const editId = options.fresh ? undefined : ctx.session.lastMenuMessageId;
  const outcome = await sendMessage(ctx.api, {
    chatId: String(chat),
    text: options.text,
    ...(options.keyboard ? { keyboard: options.keyboard } : {}),
    ...(editId === undefined ? {} : { editMessageId: editId }),
  });

  switch (outcome.kind) {
    case 'sent':
    case 'edited':
      ctx.session.lastMenuMessageId = outcome.messageId;
      return;
    case 'unchanged':
      // The screen already shows exactly this. Nothing to do.
      return;
    case 'blocked':
    case 'retry_later':
      // Nothing useful to do inside an update handler; the queue owns retries.
      ctx.deps.log.warn({ outcome: outcome.kind }, 'menu render did not reach the user');
      return;
  }
}
