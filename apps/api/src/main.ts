/**
 * The HTTP process: Telegram webhook, Mini App API, Mini App static files and
 * the health probes. Everything that takes real time happens in the worker.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createLogger, env, installShutdownHandlers } from '@alnotica/core';
import { createDb } from '@alnotica/db';
import fastifyStatic from '@fastify/static';
import { createContext } from './lib/context.js';
import { createServer } from './lib/server.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMiniAppRoutes } from './routes/miniapp.js';
import { registerWebhookRoutes } from './routes/webhook.js';

const config = env();
const log = createLogger({ level: config.LOG_LEVEL, name: 'api' });
const shutdown = installShutdownHandlers(log);

const handle = createDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
shutdown.onShutdown(() => handle.close());

const ctx = createContext({ env: config, log, handle });

const app = createServer(ctx);

registerHealthRoutes(app, ctx);
registerWebhookRoutes(app, ctx);
registerMiniAppRoutes(app, ctx);

const miniappDist = resolve(process.cwd(), config.MINIAPP_DIST);
if (existsSync(miniappDist)) {
  await app.register(fastifyStatic, { root: miniappDist, prefix: '/miniapp/' });
  log.info({ miniappDist }, 'serving mini app');
} else {
  log.warn({ miniappDist }, 'mini app bundle not found; /miniapp will 404');
}

shutdown.onShutdown(() => app.close());

await app.listen({ port: config.API_PORT, host: config.API_HOST });
log.info({ port: config.API_PORT, webhookMode: config.WEBHOOK_MODE }, 'api listening');
