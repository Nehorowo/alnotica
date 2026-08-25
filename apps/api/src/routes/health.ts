import { sql } from 'drizzle-orm';
import type { AppContext } from '../lib/context.js';
import type { App } from '../lib/server.js';

/**
 * `/healthz` says the process is alive; `/readyz` says it can serve. The alerting
 * job polls `/readyz` because a process that cannot reach Postgres is worse than
 * one that is down: it answers requests with errors.
 */
export function registerHealthRoutes(app: App, ctx: AppContext): void {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
    } catch (err) {
      ctx.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ ok: false, db: false });
    }

    const [depth, unprocessed] = await Promise.all([
      ctx.jobs.depth(),
      ctx.updates.unprocessedCount(),
    ]);

    return reply.send({ ok: true, db: true, queueDepth: depth, unprocessedUpdates: unprocessed });
  });
}
