/**
 * The periodic sweeps: expiring unconfirmed bookings, asking about no-shows, and
 * scheduling each tenant's digest in its own time zone.
 */
import { createBooking } from '@alnotica/core';
import { PENDING_TTL_MIN, appointmentCancelKey } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  autoComplete,
  enqueueNoShowQuestions,
  expirePending,
  prune,
  scheduleDigests,
} from '../apps/worker/src/scheduler.js';
import { type Fixture, type Harness, createHarness, jobs, seed } from './helpers/harness.js';

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

function slotMs(f: Fixture, days = 2, hour = 14): number {
  let dt = DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
    .plus({ days })
    .startOf('day')
    .set({ hour });
  while (dt.weekday > 5) dt = dt.plus({ days: 1 });
  return dt.toMillis();
}

/** Pushes a row's `created_at` into the past, as if it had been sitting there. */
async function backdateCreation(appointmentId: string, minutesAgo: number): Promise<void> {
  const at = new Date(h.now - minutesAgo * 60_000).toISOString();
  await h.db
    .sql`UPDATE appointment SET created_at = ${at}::timestamptz WHERE id = ${appointmentId}`;
}

describe('expiring unconfirmed bookings', () => {
  it('expires one that has waited longer than the TTL and frees its slot', async () => {
    const f = await seed(h, { autoConfirm: false });
    const startsAtMs = slotMs(f);

    const { appointment } = await createBooking(
      { db: h.db.db, queue: h.queue, nowMs: h.now },
      {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs,
        createdBy: 'client',
      },
    );
    expect(appointment.status).toBe('pending');

    // Not yet due.
    expect(await expirePending(h.jobCtx)).toBe(0);

    await backdateCreation(appointment.id, PENDING_TTL_MIN + 1);
    expect(await expirePending(h.jobCtx)).toBe(1);

    const after = await f.repo.appointments.byId(appointment.id);
    expect(after?.status).toBe('expired');

    // Expiring must extinguish the reminders, exactly like a cancellation.
    expect(await jobs(h).pendingByCancelKey(appointmentCancelKey(appointment.id))).toHaveLength(0);
    // And the slot is free again.
    expect(
      await f.repo.appointments.busySpans([f.staff.id], startsAtMs - 1, startsAtMs + 1),
    ).toEqual([]);
  });

  it('expires one whose start has already gone by', async () => {
    const f = await seed(h, { autoConfirm: false });
    // A booking nobody ever answered, for a time that has since passed. Scanning
    // only the future would leave it pending forever, still holding its slot.
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at,
                               status, created_by, created_at)
      VALUES (${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id}, 'stale-1',
              ${new Date(h.now - 3 * 86_400_000).toISOString()}::timestamptz,
              ${new Date(h.now - 3 * 86_400_000 + 3_600_000).toISOString()}::timestamptz,
              'pending', 'client',
              ${new Date(h.now - 3 * 86_400_000).toISOString()}::timestamptz)
    `;

    expect(await expirePending(h.jobCtx)).toBe(1);
    expect((await f.repo.appointments.byRef('stale-1'))?.status).toBe('expired');
  });

  it('tells both sides that the request lapsed', async () => {
    const f = await seed(h, { autoConfirm: false });
    const { appointment } = await createBooking(
      { db: h.db.db, queue: h.queue, nowMs: h.now },
      {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs: slotMs(f),
        createdBy: 'client',
      },
    );
    await backdateCreation(appointment.id, PENDING_TTL_MIN + 1);
    await expirePending(h.jobCtx);

    const { jobs: queued } = await h.queue.claim('t', 20, Date.now());
    const recipients = queued
      .filter((j) => j.payload.kind === 'send_message')
      .map((j) => (j.payload.kind === 'send_message' ? j.payload.chatId : ''));
    expect(recipients).toContain(f.staff.telegramId.toString());
    expect(recipients).toContain(f.client.telegramId?.toString());
  });

  it('does nothing for a tenant that confirms automatically', async () => {
    const f = await seed(h); // autoConfirm defaults to true
    await createBooking(
      { db: h.db.db, queue: h.queue, nowMs: h.now },
      {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs: slotMs(f),
        createdBy: 'client',
      },
    );
    expect(await expirePending(h.jobCtx)).toBe(0);
  });
});

describe('the no-show question', () => {
  it('is queued once for a visit that has finished without a verdict', async () => {
    const f = await seed(h);
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at,
                               status, created_by)
      VALUES (${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id}, 'done-1',
              ${new Date(h.now - 5 * 3_600_000).toISOString()}::timestamptz,
              ${new Date(h.now - 4 * 3_600_000).toISOString()}::timestamptz,
              'confirmed', 'client')
    `;

    expect(await enqueueNoShowQuestions(h.jobCtx)).toBe(1);
    // The dedupe key makes a second sweep a no-op, so nobody is asked twice.
    expect(await enqueueNoShowQuestions(h.jobCtx)).toBe(0);
  });

  it('is not queued while the visit is still under way', async () => {
    const f = await seed(h);
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at,
                               status, created_by)
      VALUES (${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id}, 'now-1',
              ${new Date(h.now - 600_000).toISOString()}::timestamptz,
              ${new Date(h.now + 600_000).toISOString()}::timestamptz,
              'confirmed', 'client')
    `;
    expect(await enqueueNoShowQuestions(h.jobCtx)).toBe(0);
  });
});

describe('auto-completion', () => {
  it('assumes a visit happened when the master never answered', async () => {
    const f = await seed(h);
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at,
                               status, created_by)
      VALUES (${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id}, 'old-1',
              ${new Date(h.now - 4 * 86_400_000).toISOString()}::timestamptz,
              ${new Date(h.now - 4 * 86_400_000 + 3_600_000).toISOString()}::timestamptz,
              'confirmed', 'client')
    `;

    expect(await autoComplete(h.jobCtx, 48)).toBe(1);
    // Guessing "no_show" instead would inflate the very metric the master is
    // judged on, from nothing more than their own silence.
    expect((await f.repo.appointments.byRef('old-1'))?.status).toBe('completed');
  });

  it('leaves a recent visit alone, so the master still gets to answer', async () => {
    const f = await seed(h);
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at,
                               status, created_by)
      VALUES (${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id}, 'fresh-1',
              ${new Date(h.now - 4 * 3_600_000).toISOString()}::timestamptz,
              ${new Date(h.now - 3 * 3_600_000).toISOString()}::timestamptz,
              'confirmed', 'client')
    `;
    expect(await autoComplete(h.jobCtx, 48)).toBe(0);
  });
});

describe('the daily digest', () => {
  it('is scheduled once per tenant, at 20:00 in that tenant zone', async () => {
    const moscow = await seed(h, { timezone: 'Europe/Moscow' });
    const lisbon = await seed(h, { timezone: 'Europe/Lisbon' });

    expect(await scheduleDigests(h.jobCtx)).toBe(2);
    // Re-running changes nothing: the dedupe key is (tenant, target date).
    expect(await scheduleDigests(h.jobCtx)).toBe(0);

    const { jobs: queued } = await h.queue.claim('t', 20, Date.now() + 40 * 3_600_000);
    const digests = queued.filter((j) => j.payload.kind === 'daily_digest');
    expect(digests).toHaveLength(2);

    for (const { row, payload } of digests) {
      if (payload.kind !== 'daily_digest') continue;
      const zone = payload.tenantId === moscow.tenant.id ? 'Europe/Moscow' : 'Europe/Lisbon';
      expect(DateTime.fromJSDate(row.runAt, { zone }).toFormat('HH:mm')).toBe('20:00');
      // It covers the day after it is sent.
      expect(payload.targetDate).toBe(
        DateTime.fromJSDate(row.runAt, { zone }).plus({ days: 1 }).toFormat('yyyy-MM-dd'),
      );
    }
    expect(lisbon.tenant.timezone).toBe('Europe/Lisbon');
  });
});

describe('housekeeping', () => {
  it('prunes processed updates older than a week', async () => {
    const f = await seed(h);
    const { row } = await h.ctx.updates.record(f.bot.id, 1, { update_id: 1 });
    await h.ctx.updates.markProcessed(row?.id ?? 0);
    await h.db.sql`
      UPDATE tg_update SET received_at = ${new Date(h.now - 30 * 86_400_000).toISOString()}::timestamptz
    `;

    await prune(h.jobCtx);
    expect(await h.ctx.updates.byId(row?.id ?? 0)).toBeNull();
  });

  it('keeps an update that has not been processed yet, however old', async () => {
    const f = await seed(h);
    const { row } = await h.ctx.updates.record(f.bot.id, 2, { update_id: 2 });
    await h.db.sql`
      UPDATE tg_update SET received_at = ${new Date(h.now - 30 * 86_400_000).toISOString()}::timestamptz
    `;

    await prune(h.jobCtx);
    expect(await h.ctx.updates.byId(row?.id ?? 0)).not.toBeNull();
  });
});
