/**
 * Alerting.
 *
 * One server with no standby fails silently unless something is watching, so
 * this is not a nice-to-have: it is the only thing standing between an outage and
 * finding out about it from a customer.
 *
 * Alerts go out through a separate bot token so that a broken main bot — the most
 * likely thing to break — does not also silence the alarm.
 */
import { statfs } from 'node:fs/promises';
import type { Env } from '@alnotica/core';
import type { JobContext } from './jobs/context.js';

export interface HealthSnapshot {
  readonly queueDepth: number;
  readonly deadJobs: number;
  readonly unprocessedUpdates: number;
  /** Minutes since the newest processed update, or null when none exist yet. */
  readonly updateLagMin: number | null;
  readonly diskFreeRatio: number | null;
  readonly dbReachable: boolean;
}

export const THRESHOLDS = {
  queueDepth: 500,
  deadJobs: 10,
  unprocessedUpdates: 100,
  updateLagMin: 10,
  diskFreeRatio: 0.1,
} as const;

export async function collectHealth(ctx: JobContext, path = '/'): Promise<HealthSnapshot> {
  let dbReachable = true;
  let queueDepth = 0;
  let deadJobs = 0;
  let unprocessedUpdates = 0;
  let updateLagMin: number | null = null;

  try {
    queueDepth = await ctx.queue.depth();
    unprocessedUpdates = await ctx.updates.unprocessedCount();
    const lastProcessed = await ctx.updates.lastProcessedAt();
    updateLagMin = lastProcessed ? (ctx.now() - lastProcessed.getTime()) / 60_000 : null;
    const { jobRepo } = await import('@alnotica/db');
    deadJobs = (await jobRepo(ctx.db).dead(50)).length;
  } catch (err) {
    ctx.log.error({ err }, 'health collection failed');
    dbReachable = false;
  }

  let diskFreeRatio: number | null = null;
  try {
    const stats = await statfs(path);
    diskFreeRatio = Number(stats.bavail) / Number(stats.blocks);
  } catch {
    // Not every filesystem answers statfs; a missing figure is not an outage.
    diskFreeRatio = null;
  }

  return { queueDepth, deadJobs, unprocessedUpdates, updateLagMin, diskFreeRatio, dbReachable };
}

/** Human-readable problems, empty when everything is fine. */
export function evaluate(snapshot: HealthSnapshot): string[] {
  const problems: string[] = [];

  if (!snapshot.dbReachable) problems.push('база данных недоступна');
  if (snapshot.queueDepth > THRESHOLDS.queueDepth) {
    problems.push(`очередь: ${snapshot.queueDepth} задач ждут`);
  }
  if (snapshot.deadJobs > THRESHOLDS.deadJobs) {
    problems.push(`мёртвых задач: ${snapshot.deadJobs}`);
  }
  if (snapshot.unprocessedUpdates > THRESHOLDS.unprocessedUpdates) {
    problems.push(`необработанных апдейтов: ${snapshot.unprocessedUpdates}`);
  }
  if (snapshot.updateLagMin !== null && snapshot.updateLagMin > THRESHOLDS.updateLagMin) {
    problems.push(`последний апдейт обработан ${Math.round(snapshot.updateLagMin)} мин назад`);
  }
  if (snapshot.diskFreeRatio !== null && snapshot.diskFreeRatio < THRESHOLDS.diskFreeRatio) {
    problems.push(`свободно места: ${Math.round(snapshot.diskFreeRatio * 100)}%`);
  }

  return problems;
}

/**
 * Sends an alert over plain HTTPS rather than through the bot registry: the
 * registry depends on the database, which is one of the things that can be down.
 */
export async function sendAlert(env: Env, text: string): Promise<boolean> {
  if (!env.ALERT_TG_TOKEN || !env.ALERT_TG_CHAT) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.ALERT_TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.ALERT_TG_CHAT, text, disable_notification: false }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface AlertState {
  /** What was reported last time, so an unchanged problem is not re-sent. */
  lastProblems: string;
  lastSentMs: number;
}

/** Re-announce an unresolved problem at most once an hour. */
export const REPEAT_INTERVAL_MS = 3_600_000;

export async function runAlertCycle(
  ctx: JobContext,
  state: AlertState,
  path = '/',
): Promise<HealthSnapshot> {
  const snapshot = await collectHealth(ctx, path);
  const problems = evaluate(snapshot);
  const fingerprint = problems.join('|');
  const nowMs = ctx.now();

  if (problems.length === 0) {
    if (state.lastProblems !== '') {
      await sendAlert(ctx.env, 'Всё восстановилось.');
      state.lastProblems = '';
      state.lastSentMs = nowMs;
    }
    return snapshot;
  }

  const changed = fingerprint !== state.lastProblems;
  const stale = nowMs - state.lastSentMs > REPEAT_INTERVAL_MS;
  if (changed || stale) {
    ctx.log.error({ problems }, 'health check failed');
    await sendAlert(ctx.env, `Проблемы:\n${problems.map((p) => `• ${p}`).join('\n')}`);
    state.lastProblems = fingerprint;
    state.lastSentMs = nowMs;
  }

  return snapshot;
}
