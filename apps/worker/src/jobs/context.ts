import type { BotRegistry, Env, Queue } from '@alnotica/core';
import type { Database } from '@alnotica/db';
import { botRepo, tenantRepo, updateRepo } from '@alnotica/db';
import type { Logger } from 'pino';

export interface JobContext {
  readonly db: Database;
  readonly queue: Queue;
  readonly env: Env;
  readonly log: Logger;
  readonly registry: BotRegistry;
  readonly bots: ReturnType<typeof botRepo>;
  readonly tenants: ReturnType<typeof tenantRepo>;
  readonly updates: ReturnType<typeof updateRepo>;
  now(): number;
}

export function createJobContext(input: {
  db: Database;
  queue: Queue;
  env: Env;
  log: Logger;
  registry: BotRegistry;
  nowMs?: () => number;
}): JobContext {
  return {
    db: input.db,
    queue: input.queue,
    env: input.env,
    log: input.log,
    registry: input.registry,
    bots: botRepo(input.db),
    tenants: tenantRepo(input.db),
    updates: updateRepo(input.db),
    now: () => input.nowMs?.() ?? Date.now(),
  };
}

/** A job that cannot proceed but should not be retried either. */
export class JobSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JobSkipped';
  }
}

/** A job that failed transiently and should come back later. */
export class JobRetryLater extends Error {
  constructor(
    reason: string,
    readonly retryAfterSec: number,
  ) {
    super(reason);
    this.name = 'JobRetryLater';
  }
}
