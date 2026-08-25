/**
 * Broadcasts.
 *
 * This is the feature most likely to get the shared bot banned, and a ban takes
 * every tenant down at once. So the limits are enforced here, once, on the way
 * in — not left to the UI to remember.
 */
import {
  type BroadcastRow,
  type ClientRow,
  type Database,
  type TenantRow,
  forTenant,
} from '@alnotica/db';
import {
  type AudienceFilter,
  BROADCAST_CHUNK_SIZE,
  BroadcastLimitError,
  NotFoundError,
  PRIORITY,
  type Plan,
  WINDOW_OPENED_INACTIVE_DAYS,
  assertBroadcastAllowed,
  assertFeature,
  audienceFilterSchema,
  broadcastCancelKey,
  chunk,
  chunkDelayMs,
  monthBounds,
  needsModeration,
} from '@alnotica/shared';
import type { Queue } from './queue.js';

export interface BroadcastDeps {
  readonly db: Database;
  readonly queue: Queue;
  readonly nowMs?: number;
}

/**
 * Resolves an audience filter to actual clients.
 *
 * Only filters exist — there is no way to hand us a list of chat ids, by design.
 * Consent, blocking and opt-out are re-checked here and again per recipient in
 * the sending job, because the two can be minutes apart.
 */
export async function resolveAudience(
  deps: BroadcastDeps,
  tenant: TenantRow,
  filter: AudienceFilter,
): Promise<ClientRow[]> {
  const repo = forTenant(deps.db, tenant.id);
  const nowMs = deps.nowMs ?? Date.now();
  const reachable = await repo.stats.reachableClients();

  switch (filter.kind) {
    case 'all':
      return reachable;

    case 'visited_within': {
      // "Dormant since X" is the complement of "seen since X" within the same set.
      const dormant = new Set(
        (await repo.stats.dormantClients(nowMs - filter.days * 86_400_000)).map((c) => c.id),
      );
      return reachable.filter((c) => !dormant.has(c.id));
    }

    case 'not_visited_for':
      return repo.stats.dormantClients(nowMs - filter.days * 86_400_000);

    case 'used_service': {
      const used = new Set(await repo.clients.idsWhoUsedService(filter.serviceId));
      return reachable.filter((c) => used.has(c.id));
    }
  }
}

export interface CreateBroadcastInput {
  readonly tenant: TenantRow;
  readonly text: string;
  readonly mediaId: string | null;
  readonly audience: AudienceFilter;
}

export interface CreateBroadcastResult {
  readonly broadcast: BroadcastRow;
  readonly audienceSize: number;
  /** True when a human has to approve it before anything is sent. */
  readonly moderated: boolean;
}

/** Creates a broadcast after checking every limit. Throws `BroadcastLimitError`. */
export async function createBroadcast(
  deps: BroadcastDeps,
  input: CreateBroadcastInput,
): Promise<CreateBroadcastResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(deps.db, input.tenant.id);

  // Broadcasting is a paid feature before it is anything else.
  assertFeature(input.tenant.plan, 'broadcasts');

  const audience = await resolveAudience(deps, input.tenant, input.audience);
  const { startMs } = monthBounds(nowMs, input.tenant.timezone);

  assertBroadcastAllowed({
    nowMs,
    tenantCreatedAtMs: input.tenant.createdAt.getTime(),
    sentThisMonth: await repo.broadcasts.countSince(startMs),
    lastBroadcastAtMs: (await repo.broadcasts.lastSentAt())?.getTime() ?? null,
    audienceSize: audience.length,
  });

  // The first three sends from any tenant go past a human.
  const moderated = needsModeration(await repo.broadcasts.countEverSent());

  const broadcast = await repo.broadcasts.create({
    text: input.text,
    mediaId: input.mediaId,
    audience: input.audience,
    status: moderated ? 'pending_moderation' : 'approved',
  });
  await repo.broadcasts.update(broadcast.id, { total: audience.length });

  if (!moderated) await startBroadcast(deps, input.tenant, broadcast.id);

  return { broadcast, audienceSize: audience.length, moderated };
}

/**
 * Queues the actual sending, in chunks, spaced so the slow lane stays under
 * twenty messages a second.
 */
export async function startBroadcast(
  deps: BroadcastDeps,
  tenant: TenantRow,
  broadcastId: string,
): Promise<number> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(deps.db, tenant.id);

  const broadcast = await repo.broadcasts.byId(broadcastId);
  if (!broadcast) throw new NotFoundError('broadcast');

  // The audience is jsonb: data from the database is parsed, never cast.
  const audience = await resolveAudience(
    deps,
    tenant,
    audienceFilterSchema.parse(broadcast.audience),
  );
  if (audience.length === 0) throw new BroadcastLimitError('empty_audience');

  await repo.broadcasts.update(broadcastId, {
    status: 'sending',
    startedAt: new Date(nowMs),
    total: audience.length,
    sent: 0,
    failed: 0,
  });

  const chunks = chunk(
    audience.map((c) => c.id),
    BROADCAST_CHUNK_SIZE,
  );
  const spacing = chunkDelayMs();

  await deps.queue.enqueueMany(
    chunks.map((clientIds, index) => ({
      kind: 'broadcast_chunk' as const,
      payload: { kind: 'broadcast_chunk' as const, broadcastId, clientIds, chunkIndex: index },
      // The lowest priority in the system: a blast never delays a confirmation.
      priority: PRIORITY.broadcast,
      runAt: new Date(nowMs + index * spacing),
      cancelKey: broadcastCancelKey(broadcastId),
      dedupeKey: `bc:${broadcastId}:${index}`,
    })),
  );

  return chunks.length;
}

export async function approveBroadcast(
  deps: BroadcastDeps,
  tenant: TenantRow,
  broadcastId: string,
  moderatorTelegramId: bigint,
): Promise<void> {
  const repo = forTenant(deps.db, tenant.id);
  const updated = await repo.broadcasts.update(broadcastId, {
    status: 'approved',
    moderatedBy: moderatorTelegramId,
  });
  if (!updated) throw new NotFoundError('broadcast');
  await startBroadcast(deps, tenant, broadcastId);
}

export async function rejectBroadcast(
  deps: BroadcastDeps,
  tenant: TenantRow,
  broadcastId: string,
  moderatorTelegramId: bigint,
): Promise<void> {
  const repo = forTenant(deps.db, tenant.id);
  const updated = await repo.broadcasts.update(broadcastId, {
    status: 'rejected',
    moderatedBy: moderatorTelegramId,
    finishedAt: new Date(deps.nowMs ?? Date.now()),
  });
  if (!updated) throw new NotFoundError('broadcast');
  await deps.queue.cancelByKey(broadcastCancelKey(broadcastId));
}

/* ----------------------------- a window opened ---------------------------- */

export interface WindowOpenedInput {
  readonly tenant: TenantRow;
  readonly appointmentId: string;
}

/**
 * The most valuable mechanic after reminders: a cancellation leaves a hole, and
 * one tap offers it to clients who have not been in for a month and a half.
 *
 * It goes out as a broadcast so that every limit, every opt-out and the slow lane
 * apply to it unchanged — the only difference is the text.
 */
export async function offerFreedWindow(
  deps: BroadcastDeps,
  input: WindowOpenedInput,
  buildText: (parts: { serviceName: string; when: string }) => string,
  formatWhen: (startsAt: Date, timezone: string) => string,
): Promise<CreateBroadcastResult> {
  const repo = forTenant(deps.db, input.tenant.id);
  const appointment = await repo.appointments.byId(input.appointmentId);
  if (!appointment) throw new NotFoundError('appointment');
  const service = await repo.services.byId(appointment.serviceId);
  if (!service) throw new NotFoundError('service');

  return createBroadcast(deps, {
    tenant: input.tenant,
    text: buildText({
      serviceName: service.name,
      when: formatWhen(appointment.startsAt, input.tenant.timezone),
    }),
    mediaId: null,
    audience: { kind: 'not_visited_for', days: WINDOW_OPENED_INACTIVE_DAYS },
  });
}
