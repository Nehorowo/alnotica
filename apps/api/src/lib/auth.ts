/**
 * Mini App authentication.
 *
 * There are no cookies and no sessions of our own: the only identity is
 * `user.id` from a freshly signed `initData`. The signature is checked against
 * the token of the bot that owns the tenant, so a valid `initData` from another
 * bot does not grant access here.
 */
import { READ_MAX_AGE_SEC, WRITE_MAX_AGE_SEC, verifyInitData } from '@alnotica/core';
import { type BotRow, type StaffRow, type TenantRow, forTenant } from '@alnotica/db';
import { INIT_DATA_HEADER, InitDataError, type InitDataUser } from '@alnotica/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';

export interface MiniAppIdentity {
  readonly user: InitDataUser;
  readonly tenant: TenantRow;
  readonly bot: BotRow;
  readonly repo: ReturnType<typeof forTenant>;
  readonly startParam: string | null;
}

export interface StaffIdentity extends MiniAppIdentity {
  readonly staff: StaffRow;
}

export type Intent = 'read' | 'write';

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

/**
 * Resolves the caller. Throws `InitDataError` for a bad signature and returns
 * null when the tenant does not exist — the route turns that into a 404 rather
 * than a 403, so probing for tenant slugs learns nothing.
 */
export async function authenticate(
  ctx: AppContext,
  request: FastifyRequest,
  slug: string,
  intent: Intent = 'read',
): Promise<MiniAppIdentity | null> {
  const initData = headerValue(request, INIT_DATA_HEADER);
  if (!initData) throw new InitDataError('missing header');

  const tenant = await ctx.tenants.bySlug(slug);
  if (!tenant || !tenant.isActive) return null;

  const bot = await ctx.bots.byId(tenant.botId);
  if (!bot || !bot.isActive) return null;

  const token = await ctx.tokenFor(bot);
  const verified = verifyInitData(initData, token, {
    // Fifteen minutes for anything that writes; a day for reads, so a Mini App
    // left open on a phone still renders instead of erroring out.
    maxAgeSec: intent === 'write' ? WRITE_MAX_AGE_SEC : READ_MAX_AGE_SEC,
  });

  return {
    user: verified.user,
    tenant,
    bot,
    repo: forTenant(ctx.db, tenant.id),
    startParam: verified.startParam,
  };
}

/** Same, but the caller must also be a member of the tenant's staff. */
export async function authenticateStaff(
  ctx: AppContext,
  request: FastifyRequest,
  slug: string,
  intent: Intent = 'read',
): Promise<StaffIdentity | null> {
  const identity = await authenticate(ctx, request, slug, intent);
  if (!identity) return null;

  const staff = await identity.repo.staff.byTelegramId(identity.user.id);
  // Not a member of *this* tenant: 404, exactly as if the tenant did not exist.
  if (!staff || !staff.isActive) return null;

  return { ...identity, staff };
}
