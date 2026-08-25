/**
 * Assembles a grammY bot: session storage, middleware, then the two flows.
 *
 * Order is deliberate. The staff flow runs first so that a master's plain `/start`
 * lands in their cabinet; the client flow claims `/start` with a deep-link payload
 * and everything else falls through to it.
 */
import { type BotRow, type Database, pgSessionStorage } from '@alnotica/db';
import { SlidingWindowLimiter } from '@alnotica/shared';
import { type Bot, Composer, session } from 'grammy';
import { registerAdminFlow } from './admin-flow.js';
import { registerBroadcastFlow } from './broadcast-flow.js';
import { registerClientFlow } from './client-flow.js';
import { type BotContext, type BotDeps, attachDeps } from './context.js';
import { alwaysAnswerCallbacks, errorBoundary, rateLimit } from './middleware.js';
import { type SessionData, emptySession, parseSession } from './session.js';
import { registerStaffFlow } from './staff-flow.js';
import { texts } from './texts.js';

/** Shared across every bot instance in the process: the limit is per user. */
const limiter = new SlidingWindowLimiter();

setInterval(() => limiter.sweep(Date.now()), 60_000).unref();

export interface WireOptions {
  readonly db: Database;
  readonly deps: Omit<BotDeps, 'botRow'>;
  readonly botRow: BotRow;
}

export function wireBot(bot: Bot, options: WireOptions): void {
  const typed = bot as unknown as Bot<BotContext>;
  const deps: BotDeps = { ...options.deps, botRow: options.botRow };

  typed.use(
    session({
      // Sessions live in Postgres: a deploy in the middle of a five-step
      // registration must not send the master back to step one.
      storage: pgSessionStorage<SessionData>(options.db),
      initial: emptySession,
      getSessionKey: (ctx) => (ctx.from ? `${options.botRow.id}:${ctx.from.id}` : undefined),
    }),
  );

  typed.use(async (ctx, next) => {
    attachDeps(ctx, deps);
    // A session row is JSON written by an older build; parse rather than trust.
    ctx.session = parseSession(ctx.session);
    return next();
  });

  typed.use(errorBoundary(deps.log));
  typed.use(alwaysAnswerCallbacks(deps.log));
  typed.use(rateLimit(limiter, deps.log));

  const admin = new Composer<BotContext>();
  registerAdminFlow(admin);
  typed.use(admin);

  const staff = new Composer<BotContext>();
  registerStaffFlow(staff);
  typed.use(staff);

  const broadcasts = new Composer<BotContext>();
  registerBroadcastFlow(broadcasts);
  typed.use(broadcasts);

  const client = new Composer<BotContext>();
  registerClientFlow(client);
  typed.use(client);

  typed.on('message:text', async (ctx) => {
    await ctx.reply(texts.common.unknownCommand);
  });
}

export { limiter };
