/**
 * Outbound message delivery and the taxonomy of Telegram's failures.
 *
 * Each class of error means something different for the queue:
 *  - 403 "bot was blocked": permanent for this client, but the appointment stays.
 *    The client is flagged and the master is told the reminder was not delivered.
 *  - 429: transient. auto-retry handles short waits; a long `retry_after` sends the
 *    job back to the queue instead of parking a worker.
 *  - 400 "message is not modified": not an error at all; the menu already looked
 *    the way we wanted.
 *  - 400 "message to edit not found": the user deleted it; send a fresh one.
 */
import { type Api, GrammyError, HttpError } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';

export type SendOutcome =
  | { readonly kind: 'sent'; readonly messageId: number }
  | { readonly kind: 'edited'; readonly messageId: number }
  /** Nothing changed; the message on screen is already correct. */
  | { readonly kind: 'unchanged' }
  /** The user blocked the bot or deleted their account. Stop writing to them. */
  | { readonly kind: 'blocked' }
  /** Transient; the caller should reschedule the job after `retryAfterSec`. */
  | { readonly kind: 'retry_later'; readonly retryAfterSec: number };

export interface KeyboardButton {
  readonly text: string;
  readonly data?: string | undefined;
  readonly url?: string | undefined;
  readonly webApp?: string | undefined;
}

export function toInlineKeyboard(
  rows: readonly (readonly KeyboardButton[])[] | undefined,
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (!rows || rows.length === 0) return undefined;
  const inline_keyboard = rows.map((row) =>
    row.map((b): InlineKeyboardButton => {
      if (b.url) return { text: b.text, url: b.url };
      if (b.webApp) return { text: b.text, web_app: { url: b.webApp } };
      return { text: b.text, callback_data: b.data ?? 'noop' };
    }),
  );
  return { inline_keyboard };
}

/** True when Telegram is telling us this chat is permanently unreachable. */
export function isPermanentlyUnreachable(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 403 && error.error_code !== 400) return false;
  const description = error.description.toLowerCase();
  return (
    description.includes('bot was blocked') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes("bot can't initiate conversation") ||
    description.includes('bot was kicked')
  );
}

export function retryAfterOf(error: unknown): number | null {
  if (!(error instanceof GrammyError)) return null;
  if (error.error_code !== 429) return null;
  const retryAfter = error.parameters.retry_after;
  return typeof retryAfter === 'number' ? retryAfter : 60;
}

function isNotModified(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    error.description.toLowerCase().includes('message is not modified')
  );
}

function isMessageGone(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    (error.description.toLowerCase().includes('message to edit not found') ||
      error.description.toLowerCase().includes("message can't be edited"))
  );
}

export interface SendRequest {
  readonly chatId: string;
  readonly text: string;
  readonly keyboard?: readonly (readonly KeyboardButton[])[];
  /** Edit this message instead of sending a new one, when it still exists. */
  readonly editMessageId?: number;
  readonly disablePreview?: boolean;
}

/**
 * Sends or edits one message and classifies whatever comes back.
 *
 * Text is HTML: every caller builds it through the `html` tagged template so that
 * a service named `Стрижка <люкс> & укладка` cannot break the parse.
 */
export async function sendMessage(api: Api, request: SendRequest): Promise<SendOutcome> {
  const reply_markup = toInlineKeyboard(request.keyboard);
  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: request.disablePreview ?? true },
    ...(reply_markup ? { reply_markup } : {}),
  };

  try {
    if (request.editMessageId !== undefined) {
      try {
        const edited = await api.editMessageText(
          request.chatId,
          request.editMessageId,
          request.text,
          options,
        );
        return {
          kind: 'edited',
          messageId: typeof edited === 'object' ? edited.message_id : request.editMessageId,
        };
      } catch (error) {
        // Already showing exactly this: nothing to do, and certainly not an error.
        if (isNotModified(error)) return { kind: 'unchanged' };
        // The user deleted it. Fall through and send a new one.
        if (!isMessageGone(error)) throw error;
      }
    }

    const sent = await api.sendMessage(request.chatId, request.text, options);
    return { kind: 'sent', messageId: sent.message_id };
  } catch (error) {
    if (isPermanentlyUnreachable(error)) return { kind: 'blocked' };
    const retryAfter = retryAfterOf(error);
    if (retryAfter !== null) return { kind: 'retry_later', retryAfterSec: retryAfter };
    // A network blip is worth a retry too, but through the queue's backoff.
    if (error instanceof HttpError) return { kind: 'retry_later', retryAfterSec: 30 };
    throw error;
  }
}

export { GrammyError, HttpError };
