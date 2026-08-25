import { randomUUID } from 'node:crypto';
/**
 * The worker process: the queue loop, the scheduler, and — in development — long
 * polling instead of a webhook.
 */
import process from 'node:process';
import {
  BotRegistry,
  createLogger,
  createQueue,
  env,
  installShutdownHandlers,
  parseEncryptionKey,
} from '@alnotica/core';
import { botRepo, createDb } from '@alnotica/db';
import { type AlertState, runAlertCycle } from './alerts.js';
import { wireBot } from './bot/index.js';
import { createJobContext } from './jobs/context.js';
import { processBatch } from './runner.js';
import { SCHEDULER_TASKS, dueTasks } from './scheduler.js';

const config = env();
const log = createLogger({ level: config.LOG_LEVEL, name: 'worker' });
const shutdown = installShutdownHandlers(log);

const workerId = config.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;

const handle = createDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
shutdown.onShutdown(() => handle.close());

const queue = createQueue(handle.db);
const encryptionKey = parseEncryptionKey(config.TOKEN_ENCRYPTION_KEY);

const registry = new BotRegistry({
  db: handle.db,
  log,
  sharedBotToken: config.BOT_TOKEN,
  encryptionKey,
  configure: (bot, row) => {
    wireBot(bot, {
      db: handle.db,
      botRow: row,
      deps: { db: handle.db, queue, env: config, log, registry },
    });
  },
});

const ctx = createJobContext({ db: handle.db, queue, env: config, log, registry });

/* --------------------------------- polling -------------------------------- */

if (config.WEBHOOK_MODE === 'off') {
  // Development: no public HTTPS, so updates come by long polling. The handlers
  // are identical either way — only the transport differs.
  //
  // Deliberately not awaited. Starting a bot means a getMe round trip to
  // Telegram, and blocking on that would mean an unreachable or slow Bot API
  // stops the queue loop from running at all — including the reminders, which
  // need nothing from Telegram until the moment they are sent.
  void startLongPolling();
}

async function startLongPolling(): Promise<void> {
  const bots = await botRepo(handle.db).listActive();
  for (const row of bots) {
    try {
      const resolved = await registry.byId(row.id);
      if (!resolved) continue;
      void resolved.bot.start({
        drop_pending_updates: false,
        onStart: (me) =>
          log.info({ username: me.username, mode: row.mode }, 'long polling started'),
      });
      shutdown.onShutdown(() => resolved.bot.stop());
    } catch (err) {
      // One tenant's revoked or mistyped token must not stop the others, and
      // must not stop the queue.
      log.error({ err, botId: row.id, mode: row.mode }, 'could not start polling for a bot');
    }
  }
}

/* ------------------------------- queue loop ------------------------------- */

const lastRun = new Map<string, number>();
const alertState: AlertState = { lastProblems: '', lastSentMs: 0 };
const ALERT_INTERVAL_MS = 5 * 60_000;

async function tick(): Promise<void> {
  const result = await processBatch(ctx, {
    workerId,
    concurrency: config.WORKER_CONCURRENCY,
    queue,
  });
  if (result.claimed > 0) log.debug({ ...result, workerId }, 'batch processed');

  // Alerting is deliberately outside the scheduler task list: it has to keep
  // running even when the database — and therefore the task list — is unhappy.
  if (config.ALERTS_ENABLED && Date.now() - (lastRun.get('alerts') ?? 0) >= ALERT_INTERVAL_MS) {
    lastRun.set('alerts', Date.now());
    await runAlertCycle(ctx, alertState).catch((err) => log.error({ err }, 'alert cycle failed'));
  }

  for (const task of dueTasks(lastRun, Date.now())) {
    lastRun.set(task.name, Date.now());
    try {
      const outcome = await task.run(ctx);
      if (typeof outcome === 'number' && outcome > 0) {
        log.info({ task: task.name, count: outcome }, 'scheduler task did work');
      }
    } catch (err) {
      log.error({ err, task: task.name }, 'scheduler task failed');
    }
  }
}

log.info({ workerId, webhookMode: config.WEBHOOK_MODE }, 'worker started');

// A plain loop rather than setInterval: overlapping ticks would claim the same
// jobs twice as soon as one run took longer than the interval.
while (!shutdown.stopping) {
  try {
    await tick();
  } catch (err) {
    log.error({ err }, 'worker tick failed');
  }
  await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
}
