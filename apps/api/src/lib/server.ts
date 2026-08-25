import Fastify from 'fastify';
import type { AppContext } from './context.js';

/**
 * Builds the Fastify instance. Kept separate from route registration so that
 * `App` below names the concrete instance type — Fastify's generics carry the
 * logger type, and a route registrar typed with the default `FastifyInstance`
 * would not accept an instance built with a pino logger.
 */
export function createServer(ctx: AppContext) {
  return Fastify({
    loggerInstance: ctx.log,
    // Telegram's updates are small; anything larger did not come from Telegram.
    bodyLimit: 1_000_000,
    trustProxy: true,
    // Per-request logging is noise in production, where Caddy already keeps an
    // access log; in development it is how you watch the webhook arrive.
    // (Fastify 5 warns that this moves under `logController` in v6.)
    disableRequestLogging: ctx.env.NODE_ENV === 'production',
  });
}

export type App = ReturnType<typeof createServer>;
