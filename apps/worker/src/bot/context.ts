/**
 * The bot's context type and the dependencies handlers reach for.
 *
 * `deps` is passed explicitly rather than imported as a singleton so a test can
 * drive the same handlers against its own database and its own fake clock.
 */
import type { BotRegistry, Env, Queue } from '@alnotica/core';
import type { BotRow, Database } from '@alnotica/db';
import { forTenant, tenantRepo } from '@alnotica/db';
import type { Context, SessionFlavor } from 'grammy';
import type { Logger } from 'pino';
import type { SessionData } from './session.js';

export interface BotDeps {
  readonly db: Database;
  readonly queue: Queue;
  readonly env: Env;
  readonly log: Logger;
  readonly registry: BotRegistry;
  /** The bot row this update arrived on; decides which tenants are reachable. */
  readonly botRow: BotRow;
  readonly nowMs?: () => number;
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    deps: BotDeps;
    /** Tenant-scoped repository, once a tenant is known. */
    tenantRepo(tenantId: string): ReturnType<typeof forTenant>;
    tenants: ReturnType<typeof tenantRepo>;
    now(): number;
  };

export function attachDeps(ctx: Context, deps: BotDeps): asserts ctx is BotContext {
  const target = ctx as BotContext;
  target.deps = deps;
  target.tenants = tenantRepo(deps.db);
  target.tenantRepo = (tenantId: string) => forTenant(deps.db, tenantId);
  target.now = () => deps.nowMs?.() ?? Date.now();
}

/** The Telegram id of whoever sent the update, as a bigint. */
export function senderId(ctx: Context): bigint | null {
  const id = ctx.from?.id;
  return id === undefined ? null : BigInt(id);
}

export function chatId(ctx: Context): string | null {
  const id = ctx.chat?.id ?? ctx.from?.id;
  return id === undefined ? null : String(id);
}

export function displayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'Клиент';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Клиент';
}
