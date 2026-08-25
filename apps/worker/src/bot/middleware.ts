/**
 * Cross-cutting bot middleware.
 */
import { type RateLimitedError, type SlidingWindowLimiter, isDomainError } from '@alnotica/shared';
import type { Context, MiddlewareFn, NextFunction } from 'grammy';
import type { Logger } from 'pino';
import { texts } from './texts.js';

/**
 * Telegram spins a loading indicator on a tapped button until the bot answers the
 * callback query. Forgetting one leaves the client watching it forever, so this
 * wrapper answers exactly once no matter how the handler ends.
 */
export function alwaysAnswerCallbacks(log: Logger): MiddlewareFn<Context> {
  return async (ctx: Context, next: NextFunction) => {
    if (!ctx.callbackQuery) return next();

    let answered = false;
    const original = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = async (...args: Parameters<typeof original>) => {
      answered = true;
      return original(...args);
    };

    try {
      await next();
    } catch (error) {
      if (!answered) {
        const text = isDomainError(error) ? error.message : texts.common.somethingWentWrong;
        // `show_alert` for a real problem: a toast is too easy to miss.
        await original({ text: text.slice(0, 200), show_alert: true }).catch(() => {});
        answered = true;
      }
      throw error;
    } finally {
      if (!answered) {
        // The indicator must stop even when the handler did nothing visible.
        await original().catch((err) => log.debug({ err }, 'answerCallbackQuery failed'));
      }
    }
  };
}

/**
 * Twenty actions a minute per user. In-process: with a single box there is nothing
 * to share the counter with, and losing it on restart is harmless.
 */
export function rateLimit(limiter: SlidingWindowLimiter, log: Logger): MiddlewareFn<Context> {
  return async (ctx: Context, next: NextFunction) => {
    const from = ctx.from?.id;
    if (from === undefined) return next();

    if (!limiter.tryAcquire(String(from), Date.now())) {
      log.warn({ telegramId: from }, 'user rate limited');
      if (ctx.callbackQuery) {
        await ctx
          .answerCallbackQuery({ text: texts.errors.rateLimited, show_alert: true })
          .catch(() => {});
      }
      return undefined;
    }
    return next();
  };
}

/** Turns a thrown domain error into a message the user can act on. */
export function errorBoundary(log: Logger): MiddlewareFn<Context> {
  return async (ctx: Context, next: NextFunction) => {
    try {
      await next();
    } catch (error) {
      if (isDomainError(error)) {
        log.info({ code: error.code, telegramId: ctx.from?.id }, 'domain error surfaced to user');
        await ctx.reply(error.message).catch(() => {});
        return;
      }
      log.error({ err: error, telegramId: ctx.from?.id }, 'bot handler failed');
      await ctx.reply(texts.common.somethingWentWrong).catch(() => {});
    }
  };
}

export type { RateLimitedError };
