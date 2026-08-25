/**
 * How the outbound path behaves when Telegram says no.
 *
 * The mock replaces the HTTP transport only, so the real grammY client, the real
 * throttler and the real auto-retry plugin are all exercised.
 */
import { randomUUID } from 'node:crypto';
import { createBooking } from '@alnotica/core';
import { appointmentCancelKey } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processBatch, runJob } from '../apps/worker/src/runner.js';
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
  // These tests are about the queue and the transport, so the clock is the real
  // one: jobs are enqueued with `run_at = now()` and have to be claimable.
  h.now = Date.now();
});

/** The next weekday at 14:00 in the tenant's zone — inside working hours. */
function slotMs(f: Fixture): number {
  let dt = DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
    .plus({ days: 2 })
    .startOf('day')
    .set({ hour: 14 });
  while (dt.weekday > 5) dt = dt.plus({ days: 1 });
  return dt.toMillis();
}

async function bookOne(f: Fixture) {
  return createBooking(
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
}

const runner = () => ({ workerId: 'test-worker', concurrency: 4, queue: h.queue });

/**
 * Runs one batch. The clock is refreshed first: jobs are inserted with
 * `run_at = now()`, so a claim stamped even a few milliseconds earlier finds
 * nothing.
 */
async function drain() {
  h.now = Date.now();
  return processBatch(h.jobCtx, runner());
}

describe('429 Too Many Requests', () => {
  it('retries within the plugin budget and still delivers', async () => {
    const f = await seed(h);
    // Two flood waits: auto-retry absorbs both, the message still goes out.
    h.telegram.floodWait('sendMessage', 1, 2);

    await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: f.client.telegramId?.toString() ?? '1',
        text: 'привет',
        disablePreview: true,
        marketing: false,
        tenantId: f.tenant.id,
      },
      priority: 10,
    });

    const result = await drain();
    expect(result.succeeded).toBe(1);
    // Three attempts total: two refused, one accepted.
    expect(h.telegram.callsTo('sendMessage')).toHaveLength(3);
  });

  it('puts the job back in the queue rather than blocking on a long wait', async () => {
    const f = await seed(h);
    // Longer than the plugin's ceiling, so it surfaces to the queue instead.
    h.telegram.floodWait('sendMessage', 120, 99);

    const created = await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: '555',
        text: 'привет',
        disablePreview: true,
        marketing: false,
        tenantId: f.tenant.id,
      },
      priority: 10,
    });

    const result = await drain();
    expect(result.retried).toBe(1);
    expect(result.dead).toBe(0);

    const row = await jobs(h).byId(created?.id ?? 0);
    expect(row?.finishedAt).toBeNull();
    // Rescheduled roughly when Telegram asked, not looping immediately.
    expect((row?.runAt.getTime() ?? 0) - h.now).toBeGreaterThan(60_000);
    expect(row?.lastError).toContain('wait');

    // And it is not claimable until then, so the worker is free meanwhile.
    expect((await h.queue.claim('test-worker', 5, Date.now())).jobs).toHaveLength(0);
  });

  it('gives up after the attempt budget instead of retrying forever', async () => {
    const f = await seed(h);
    h.telegram.floodWait('sendMessage', 120, 999);

    const created = await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: '555',
        text: 'привет',
        disablePreview: true,
        marketing: false,
        tenantId: f.tenant.id,
      },
      priority: 10,
      maxAttempts: 2,
    });
    const id = created?.id ?? 0;

    // Each pass is one attempt; the job is due again immediately in this test.
    for (let i = 0; i < 3; i++) {
      const row = await jobs(h).byId(id);
      if (row?.finishedAt) break;
      await jobs(h).fail(id, 'forced due', new Date(Date.now() - 1000));
      h.now = Date.now();
      await processBatch(h.jobCtx, { ...runner(), workerId: `w${i}` });
    }

    const finished = await jobs(h).byId(id);
    expect(finished?.finishedAt).not.toBeNull();
    expect((await jobs(h).dead()).map((j) => j.id)).toContain(id);
  });
});

describe('403 bot was blocked', () => {
  it('flags the client, keeps the appointment, and tells the master', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    h.telegram.blocked('sendMessage');

    await expect(
      runJob(h.jobCtx, { kind: 'reminder', appointmentId: appointment.id, offsetMin: 1440 }),
    ).rejects.toThrow(/blocked/);

    const client = await f.repo.clients.byId(f.client.id);
    expect(client?.isBlocked).toBe(true);

    // The booking is untouched: the client may still turn up.
    const still = await f.repo.appointments.byId(appointment.id);
    expect(still?.status).toBe('confirmed');

    // The failed delivery is recorded, so the statistics stay honest.
    const stats = await f.repo.reminders.deliveryStats(h.now - 86_400_000, h.now + 86_400_000);
    expect(stats.remindersSent).toBe(0);

    // And the master is told, or they will assume the client was reminded.
    const notice = await jobs(h).pendingByCancelKey('none');
    expect(notice).toHaveLength(0);
    const queued = await h.queue.claim('check', 10, Date.now());
    expect(queued.jobs.some((j) => j.payload.kind === 'send_message')).toBe(true);
  });

  it('treats the job as finished rather than retrying a permanent failure', async () => {
    const f = await seed(h);
    h.telegram.blocked('sendMessage');

    const created = await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: f.client.telegramId?.toString() ?? '1',
        text: 'привет',
        disablePreview: true,
        marketing: false,
        tenantId: f.tenant.id,
        clientId: f.client.id,
      },
      priority: 10,
    });

    const result = await drain();
    expect(result.skipped).toBe(1);

    const row = await jobs(h).byId(created?.id ?? 0);
    expect(row?.finishedAt).not.toBeNull();
    // Not dead: nothing is broken, the user simply left.
    expect((await jobs(h).dead()).map((j) => j.id)).not.toContain(created?.id);
    expect((await f.repo.clients.byId(f.client.id))?.isBlocked).toBe(true);
  });
});

describe('400 message is not modified', () => {
  it('is swallowed, because the screen already shows what we wanted', async () => {
    const f = await seed(h);
    h.telegram.respond((method) =>
      method === 'editMessageText'
        ? {
            status: 400,
            payload: {
              ok: false,
              error_code: 400,
              description: 'Bad Request: message is not modified',
            },
          }
        : null,
    );

    await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: '555',
        text: 'то же самое',
        editMessageId: 42,
        disablePreview: true,
        marketing: false,
      },
      priority: 10,
    });

    const result = await drain();
    expect(result.succeeded).toBe(1);
    expect(h.telegram.callsTo('sendMessage')).toHaveLength(0);
  });
});

describe('400 message to edit not found', () => {
  it('sends a new message instead', async () => {
    const f = await seed(h);
    h.telegram.respond((method) =>
      method === 'editMessageText'
        ? {
            status: 400,
            payload: {
              ok: false,
              error_code: 400,
              description: 'Bad Request: message to edit not found',
            },
          }
        : null,
    );

    await h.queue.enqueue({
      kind: 'send_message',
      payload: {
        kind: 'send_message',
        botId: f.bot.id,
        chatId: '555',
        text: 'заново',
        editMessageId: 42,
        disablePreview: true,
        marketing: false,
      },
      priority: 10,
    });

    const result = await drain();
    expect(result.succeeded).toBe(1);
    // The user deleted the old message, so a fresh one takes its place.
    expect(h.telegram.callsTo('sendMessage')).toHaveLength(1);
  });
});

describe('queue hygiene', () => {
  it('buries a payload this build cannot parse instead of retrying it', async () => {
    const f = await seed(h);
    // Written by a hypothetical future deployment.
    // A JSON string with an explicit cast: drizzle has replaced the driver's
    // jsonb serializer, so an object parameter would not survive the wire.
    const payload = JSON.stringify({ kind: 'send_message', nonsense: true });
    await h.db.sql`
      INSERT INTO job (kind, payload, priority)
      VALUES ('send_message', ${payload}::jsonb, 10)
    `;

    const result = await drain();
    expect(result.dead).toBe(1);
    expect((await jobs(h).dead())[0]?.lastError).toContain('validation');
    expect(f.tenant.id).toBeDefined();
  });

  it('serves transactional traffic before a broadcast', async () => {
    const f = await seed(h);
    await h.queue.enqueue({
      kind: 'broadcast_chunk',
      payload: {
        kind: 'broadcast_chunk',
        broadcastId: randomUUID(),
        clientIds: [f.client.id],
        chunkIndex: 0,
      },
      priority: 900,
    });
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

    const { jobs: claimed } = await h.queue.claim('w', 2, Date.now());
    expect(claimed[0]?.payload.kind).toBe('send_message');
  });

  it('extinguishes reminders for an appointment with one statement', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    expect(await jobs(h).pendingByCancelKey(appointmentCancelKey(appointment.id))).toHaveLength(3);
    expect(await h.queue.cancelByKey(appointmentCancelKey(appointment.id))).toBe(3);
  });
});
