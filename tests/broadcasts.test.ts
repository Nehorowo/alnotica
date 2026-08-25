/**
 * Broadcast limits and moderation.
 *
 * A shared bot banned for spam kills every tenant at once, so these limits are
 * load-bearing, not advisory.
 */
import {
  approveBroadcast,
  createBooking,
  createBroadcast,
  offerFreedWindow,
  rejectBroadcast,
  resolveAudience,
} from '@alnotica/core';
import {
  BroadcastLimitError,
  MAX_BROADCASTS_PER_MONTH,
  PlanFeatureError,
  WINDOW_OPENED_INACTIVE_DAYS,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processBatch } from '../apps/worker/src/runner.js';
import { type Fixture, type Harness, createHarness, seed } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  h.now = Date.now();
});

const deps = () => ({ db: h.db.db, queue: h.queue, nowMs: h.now });
const DAY = 86_400_000;

/** A pro tenant old enough to broadcast, with `count` reachable clients. */
async function proTenant(count = 3): Promise<Fixture> {
  const f = await seed(h, { plan: 'pro' });
  await h.ctx.tenants.update(f.tenant.id, {});
  await h.db.sql`
    UPDATE tenant SET created_at = ${new Date(h.now - 30 * DAY).toISOString()}::timestamptz
     WHERE id = ${f.tenant.id}
  `;
  for (let i = 0; i < count - 1; i++) {
    const c = await f.repo.clients.upsertTelegram({
      telegramId: BigInt(6_000_000_000 + i),
      name: `Клиент ${i}`,
    });
    await f.repo.clients.recordConsent(c.id);
  }
  const tenant = await h.ctx.tenants.byId(f.tenant.id);
  if (!tenant) throw new Error('unreachable');
  return { ...f, tenant };
}

const draft = {
  text: 'Скидка 20% на этой неделе',
  mediaId: null,
  audience: { kind: 'all' } as const,
};

describe('audience', () => {
  it('counts only clients we may lawfully message', async () => {
    const f = await proTenant(4);
    expect(await resolveAudience(deps(), f.tenant, { kind: 'all' })).toHaveLength(4);

    // Opting out, blocking and withholding consent each remove one.
    const [a, b, c] = await f.repo.clients.search('', 10);
    if (!a || !b || !c) throw new Error('unreachable');
    await f.repo.clients.optOut(a.id);
    await f.repo.clients.markBlocked(b.id);
    await f.repo.clients.update(c.id, { consentAt: null });

    expect(await resolveAudience(deps(), f.tenant, { kind: 'all' })).toHaveLength(1);
  });

  it('never includes a client the master typed in by hand', async () => {
    const f = await proTenant(1);
    await f.repo.clients.createManual({ name: 'Без телеграма' });
    expect(await resolveAudience(deps(), f.tenant, { kind: 'all' })).toHaveLength(1);
  });

  it('splits recent visitors from lapsed ones', async () => {
    const f = await proTenant(2);
    const startsAtMs = DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
      .plus({ days: 2 })
      .startOf('day')
      .set({ hour: 14 })
      .toMillis();
    const adjusted = new Date(startsAtMs).getUTCDay() >= 5 ? startsAtMs + 3 * DAY : startsAtMs;
    await createBooking(deps(), {
      tenant: f.tenant,
      service: f.service,
      staff: f.staff,
      client: f.client,
      startsAtMs: adjusted,
      createdBy: 'staff',
      force: true,
    });

    const lapsed = await resolveAudience(deps(), f.tenant, { kind: 'not_visited_for', days: 45 });
    // The one with an upcoming booking is not "lapsed" — do not chase them.
    expect(lapsed.map((c) => c.id)).not.toContain(f.client.id);

    const recent = await resolveAudience(deps(), f.tenant, { kind: 'visited_within', days: 45 });
    expect(recent.map((c) => c.id)).toContain(f.client.id);
  });
});

describe('limits', () => {
  it('refuses a tenant younger than a week', async () => {
    const f = await seed(h, { plan: 'pro' });
    await expect(createBroadcast(deps(), { tenant: f.tenant, ...draft })).rejects.toMatchObject({
      reason: 'tenant_too_young',
    });
  });

  it('refuses a fifth broadcast in the same month', async () => {
    const f = await proTenant();

    for (let i = 0; i < MAX_BROADCASTS_PER_MONTH; i++) {
      // Each send is pushed far enough back to clear the 48-hour cooldown.
      await createBroadcast({ ...deps(), nowMs: h.now }, { tenant: f.tenant, ...draft });
      // Backdate it so the 48-hour cooldown is clear for the next one.
      const past = new Date(h.now - (10 + i) * DAY).toISOString();
      await h.db.sql`
        UPDATE broadcast SET started_at = ${past}::timestamptz, created_at = ${past}::timestamptz
         WHERE tenant_id = ${f.tenant.id} AND started_at IS NULL OR tenant_id = ${f.tenant.id}
      `;
    }

    await expect(createBroadcast(deps(), { tenant: f.tenant, ...draft })).rejects.toMatchObject({
      reason: 'monthly_quota',
    });
  });

  it('refuses a second broadcast inside 48 hours', async () => {
    const f = await proTenant();
    await createBroadcast(deps(), { tenant: f.tenant, ...draft });

    await expect(createBroadcast(deps(), { tenant: f.tenant, ...draft })).rejects.toMatchObject({
      reason: 'cooldown',
    });

    // Two days later it is allowed again.
    const later = { db: h.db.db, queue: h.queue, nowMs: h.now + 49 * 3_600_000 };
    await expect(createBroadcast(later, { tenant: f.tenant, ...draft })).resolves.toBeTruthy();
  });

  it('refuses an empty audience', async () => {
    const f = await proTenant(1);
    const only = (await f.repo.clients.search('', 10))[0];
    if (!only) throw new Error('unreachable');
    await f.repo.clients.optOut(only.id);

    await expect(createBroadcast(deps(), { tenant: f.tenant, ...draft })).rejects.toMatchObject({
      reason: 'empty_audience',
    });
  });

  it('refuses a free-tier tenant outright', async () => {
    const f = await seed(h);
    await h.db
      .sql`UPDATE tenant SET created_at = ${new Date(h.now - 30 * DAY).toISOString()}::timestamptz WHERE id = ${f.tenant.id}`;
    const tenant = await h.ctx.tenants.byId(f.tenant.id);
    if (!tenant) throw new Error('unreachable');

    await expect(createBroadcast(deps(), { tenant, ...draft })).rejects.toBeInstanceOf(
      PlanFeatureError,
    );
  });

  it('reports the precise reason, not a generic failure', async () => {
    const f = await seed(h, { plan: 'pro' });
    try {
      await createBroadcast(deps(), { tenant: f.tenant, ...draft });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastLimitError);
      expect((e as BroadcastLimitError).userFacing).toBe(true);
    }
  });
});

describe('moderation', () => {
  it('holds the first three broadcasts and sends the fourth straight away', async () => {
    const f = await proTenant();

    for (let i = 0; i < 3; i++) {
      const result = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
      expect(result.moderated).toBe(true);
      expect(result.broadcast.status).toBe('pending_moderation');
      // Nothing is queued until a human approves.
      expect(await h.queue.depth()).toBe(0);

      await approveBroadcast(deps(), f.tenant, result.broadcast.id, 42n);
      // Backdate so the next one is not blocked by the cooldown.
      const past = new Date(h.now - (10 + i) * DAY).toISOString();
      await h.db.sql`
        UPDATE broadcast SET started_at = ${past}::timestamptz, created_at = ${past}::timestamptz
         WHERE id = ${result.broadcast.id}
      `;
      await h.queue.cancelByKey(`broadcast:${result.broadcast.id}`);
    }

    const fourth = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    expect(fourth.moderated).toBe(false);
    expect(fourth.broadcast.status).toBe('approved');
  });

  it('queues chunks only once approved', async () => {
    const f = await proTenant();
    const { broadcast } = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    expect(await h.queue.depth()).toBe(0);

    await approveBroadcast(deps(), f.tenant, broadcast.id, 42n);
    expect(await h.queue.depth()).toBeGreaterThan(0);

    const after = await f.repo.broadcasts.byId(broadcast.id);
    expect(after?.status).toBe('sending');
    expect(after?.moderatedBy).toBe(42n);
  });

  it('extinguishes the queue when a broadcast is rejected', async () => {
    const f = await proTenant();
    const { broadcast } = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    await approveBroadcast(deps(), f.tenant, broadcast.id, 42n);
    expect(await h.queue.depth()).toBeGreaterThan(0);

    await rejectBroadcast(deps(), f.tenant, broadcast.id, 42n);
    expect(await h.queue.depth()).toBe(0);
    expect((await f.repo.broadcasts.byId(broadcast.id))?.status).toBe('rejected');
  });
});

describe('sending', () => {
  it('delivers to the audience with an unsubscribe button on every message', async () => {
    const f = await proTenant(3);
    const { broadcast } = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    await approveBroadcast(deps(), f.tenant, broadcast.id, 42n);

    h.now = Date.now();
    await processBatch(h.jobCtx, { workerId: 'bc', concurrency: 4, queue: h.queue });

    const sent = h.telegram.callsTo('sendMessage');
    expect(sent).toHaveLength(3);
    for (const call of sent) {
      const markup = call.body.reply_markup as { inline_keyboard: { text: string }[][] };
      expect(markup.inline_keyboard.flat().map((b) => b.text)).toContain('Отписаться');
    }

    const finished = await f.repo.broadcasts.byId(broadcast.id);
    expect(finished?.sent).toBe(3);
    expect(finished?.status).toBe('sent');
  });

  it('skips a client who opted out between planning and sending', async () => {
    const f = await proTenant(3);
    const { broadcast } = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    await approveBroadcast(deps(), f.tenant, broadcast.id, 42n);

    // The window between the chunk being planned and the chunk being sent is
    // exactly where an opt-out gets ignored by a careless implementation.
    const someone = (await f.repo.clients.search('', 10))[0];
    if (!someone) throw new Error('unreachable');
    await f.repo.clients.optOut(someone.id);

    h.now = Date.now();
    await processBatch(h.jobCtx, { workerId: 'bc', concurrency: 4, queue: h.queue });

    expect(h.telegram.callsTo('sendMessage')).toHaveLength(2);
  });

  it('runs at the lowest priority, behind transactional traffic', async () => {
    const f = await proTenant(3);
    const { broadcast } = await createBroadcast(deps(), { tenant: f.tenant, ...draft });
    await approveBroadcast(deps(), f.tenant, broadcast.id, 42n);

    await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: '555',
        text: 'срочно',
        disablePreview: true,
        marketing: false,
      },
      priority: 10,
    });

    const { jobs: claimed } = await h.queue.claim('w', 5, Date.now());
    expect(claimed[0]?.payload.kind).toBe('send_message');
  });
});

describe('a window opened', () => {
  it('offers a freed slot to clients who have not been in for a month and a half', async () => {
    const f = await proTenant(3);
    const startsAtMs = DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
      .plus({ days: 2 })
      .startOf('day')
      .set({ hour: 14 })
      .toMillis();

    const { appointment } = await createBooking(deps(), {
      tenant: f.tenant,
      service: f.service,
      staff: f.staff,
      client: f.client,
      startsAtMs,
      createdBy: 'staff',
      force: true,
    });

    const result = await offerFreedWindow(
      deps(),
      { tenant: f.tenant, appointmentId: appointment.id },
      ({ serviceName, when }) => `Освободилось окно: ${serviceName}, ${when}`,
      (date, zone) => DateTime.fromJSDate(date, { zone }).toFormat('dd.MM HH:mm'),
    );

    expect(result.broadcast.text).toContain('Освободилось окно');
    expect(result.broadcast.audience).toMatchObject({
      kind: 'not_visited_for',
      days: WINDOW_OPENED_INACTIVE_DAYS,
    });
    // The client who holds the booking is not offered their own slot back.
    expect(result.audienceSize).toBe(2);
  });
});
