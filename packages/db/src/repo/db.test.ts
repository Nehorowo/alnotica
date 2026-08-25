/**
 * Database-level tests. These run against a real Postgres 16 (see
 * `src/testing/index.ts`) because the behaviour under test — an EXCLUDE
 * constraint, `FOR UPDATE SKIP LOCKED`, a partial unique index — has no
 * meaningful in-memory equivalent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_ERRORS, isExclusionViolation, isUniqueViolation, pgErrorCode } from '../client.js';
import { type TestDb, openTestDb } from '../testing/index.js';
import { botRepo } from './bots.js';
import { jobRepo } from './jobs.js';
import { pgSessionStorage } from './session.js';
import { SlotAlreadyTakenError, forTenant } from './tenant-scoped.js';
import { tenantRepo } from './tenants.js';
import { updateRepo } from './updates.js';

let t: TestDb;

/** A Telegram id comfortably past 2^53. */
const HUGE_TELEGRAM_ID = 9_007_199_254_740_993n;

beforeAll(async () => {
  t = await openTestDb();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.reset();
});

async function seedTenant(slug: string) {
  const bots = botRepo(t.db);
  const tenants = tenantRepo(t.db);
  const b = await bots.create({ mode: 'shared', username: `bot_${slug}`, botHash: `hash_${slug}` });
  const tn = await tenants.create({
    slug,
    title: `Салон ${slug}`,
    kind: 'grooming',
    timezone: 'Europe/Moscow',
    botId: b.id,
  });
  const repo = forTenant(t.db, tn.id);
  const master = await repo.staff.create({
    telegramId: HUGE_TELEGRAM_ID + BigInt(slug.length),
    name: 'Аня',
    role: 'owner',
  });
  const svc = await repo.services.create({
    name: 'Стрижка <люкс>',
    description: null,
    durationMin: 60,
    bufferAfterMin: 15,
    priceMinor: 300_000,
    currency: 'RUB',
    sortOrder: 0,
  });
  const cl = await repo.clients.upsertTelegram({
    telegramId: 555_000n + BigInt(slug.length),
    name: 'Иван',
  });
  return { bot: b, tenant: tn, repo, master, service: svc, client: cl };
}

const at = (iso: string) => new Date(iso);

describe('bigint round trip', () => {
  it('carries a Telegram id past 2^53 through the database unchanged', async () => {
    const { repo, master } = await seedTenant('bigint');
    expect(typeof master.telegramId).toBe('bigint');
    const back = await repo.staff.byId(master.id);
    expect(back?.telegramId).toBe(HUGE_TELEGRAM_ID + 6n);
    expect(back?.telegramId?.toString()).toBe('9007199254740999');
    // Going through Number on the way would have silently rewritten the id.
    expect(BigInt(Number(HUGE_TELEGRAM_ID + 6n))).not.toBe(HUGE_TELEGRAM_ID + 6n);

    const found = await repo.staff.byTelegramId(HUGE_TELEGRAM_ID + 6n);
    expect(found?.id).toBe(master.id);

    const memberships = await tenantRepo(t.db).membershipsOf(HUGE_TELEGRAM_ID + 6n);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.staff.telegramId).toBe(HUGE_TELEGRAM_ID + 6n);
  });
});

describe('double booking', () => {
  it('lets exactly one of two concurrent transactions take the slot', async () => {
    const { repo, master, service, client } = await seedTenant('race');
    const startsAt = at('2024-06-05T09:00:00Z');
    const endsAt = at('2024-06-05T10:15:00Z');

    // Two transactions that both hold their insert open before either commits.
    // Timestamps go over as ISO strings: `drizzle()` has replaced postgres.js's
    // date serializers with identity functions (see client.ts).
    const startsIso = startsAt.toISOString();
    const endsIso = endsAt.toISOString();
    const attempt = (ref: string) =>
      t.sql.begin(async (tx) => {
        await tx`
          INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at, status, created_by)
          VALUES (${repo.tenantId}, ${master.id}, ${service.id}, ${client.id}, ${ref},
                  ${startsIso}::timestamptz, ${endsIso}::timestamptz, 'confirmed', 'client')
        `;
        return ref;
      });

    const results = await Promise.allSettled([attempt('ref-a'), attempt('ref-b')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : null;
    // Matched on SQLSTATE, never on the message: the text is localized.
    expect(pgErrorCode(reason)).toBe(PG_ERRORS.exclusionViolation);
    expect(isExclusionViolation(reason, 'appointment_no_overlap')).toBe(true);

    const rows = await repo.appointments.listBetween(startsAt.getTime(), endsAt.getTime());
    expect(rows).toHaveLength(1);
  });

  it('surfaces the collision as a domain error from the repository', async () => {
    const { repo, master, service, client } = await seedTenant('domainerr');
    const base = {
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:15:00Z'),
      status: 'confirmed',
      createdBy: 'client' as const,
    };
    await repo.appointments.create({ ...base, ref: 'r1' });
    await expect(repo.appointments.create({ ...base, ref: 'r2' })).rejects.toBeInstanceOf(
      SlotAlreadyTakenError,
    );
  });

  it('blocks an overlap, not a booking that merely touches the boundary', async () => {
    const { repo, master, service, client } = await seedTenant('touch');
    const base = {
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      status: 'confirmed',
      createdBy: 'client' as const,
    };
    await repo.appointments.create({
      ...base,
      ref: 'a',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
    });
    // The range is half-open, so starting exactly where the previous one ends is fine.
    await expect(
      repo.appointments.create({
        ...base,
        ref: 'b',
        startsAt: at('2024-06-05T10:00:00Z'),
        endsAt: at('2024-06-05T11:00:00Z'),
      }),
    ).resolves.toBeTruthy();
    // Overlapping by a minute is not.
    await expect(
      repo.appointments.create({
        ...base,
        ref: 'c',
        startsAt: at('2024-06-05T09:59:00Z'),
        endsAt: at('2024-06-05T10:30:00Z'),
      }),
    ).rejects.toBeInstanceOf(SlotAlreadyTakenError);
  });

  it('releases the slot once the appointment is cancelled', async () => {
    const { repo, master, service, client } = await seedTenant('release');
    const base = {
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      status: 'confirmed',
      createdBy: 'client' as const,
    };
    const first = await repo.appointments.create({
      ...base,
      ref: 'a',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
    });
    await repo.appointments.transition(first.id, ['confirmed'], 'cancelled_by_client', {
      cancelledAt: new Date(),
    });
    // The EXCLUDE constraint only covers pending and confirmed, so the span is free again.
    await expect(
      repo.appointments.create({
        ...base,
        ref: 'b',
        startsAt: at('2024-06-05T09:00:00Z'),
        endsAt: at('2024-06-05T10:00:00Z'),
      }),
    ).resolves.toBeTruthy();
  });

  it('does not let one master be on holiday twice at once', async () => {
    const { repo, master } = await seedTenant('holiday');
    await repo.schedule.addTimeOff(
      master.id,
      at('2024-07-01T00:00:00Z'),
      at('2024-07-10T00:00:00Z'),
      'отпуск',
    );
    await expect(
      repo.schedule.addTimeOff(master.id, at('2024-07-05T00:00:00Z'), at('2024-07-12T00:00:00Z')),
    ).rejects.toSatisfy((e: unknown) => isExclusionViolation(e, 'time_off_no_overlap'));
  });
});

describe('tenant isolation at the repository level', () => {
  it('cannot see another tenant rows by id', async () => {
    const a = await seedTenant('alpha');
    const b = await seedTenant('bravo');

    expect(await a.repo.services.byId(b.service.id)).toBeNull();
    expect(await a.repo.staff.byId(b.master.id)).toBeNull();
    expect(await a.repo.clients.byId(b.client.id)).toBeNull();

    const bAppt = await b.repo.appointments.create({
      staffId: b.master.id,
      serviceId: b.service.id,
      clientId: b.client.id,
      ref: 'bravo-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
      status: 'confirmed',
      createdBy: 'client',
    });
    expect(await a.repo.appointments.byId(bAppt.id)).toBeNull();
    expect(await a.repo.appointments.byRef('bravo-1')).toBeNull();
  });

  it('cannot mutate another tenant rows', async () => {
    const a = await seedTenant('charlie');
    const b = await seedTenant('delta');

    expect(await a.repo.services.update(b.service.id, { name: 'взломано' })).toBeNull();
    expect(await a.repo.services.deactivate(b.service.id)).toBe(false);
    expect(await a.repo.clients.update(b.client.id, { notes: 'взломано' })).toBeNull();

    // The victim is untouched.
    expect((await b.repo.services.byId(b.service.id))?.name).toBe('Стрижка <люкс>');
    expect((await b.repo.services.byId(b.service.id))?.isActive).toBe(true);
  });

  it('cannot attach time off to another tenant staff', async () => {
    const a = await seedTenant('echo');
    const b = await seedTenant('foxtrot');
    expect(
      await a.repo.schedule.addTimeOff(
        b.master.id,
        at('2024-07-01T00:00:00Z'),
        at('2024-07-02T00:00:00Z'),
      ),
    ).toBeNull();
    expect(await a.repo.schedule.workingHoursFor(b.master.id)).toEqual([]);
    expect(await a.repo.appointments.busySpans([b.master.id], 0, 9e12)).toEqual([]);
  });

  it('keeps statistics and searches inside the tenant', async () => {
    const a = await seedTenant('golf');
    const b = await seedTenant('hotel');
    await b.repo.appointments.create({
      staffId: b.master.id,
      serviceId: b.service.id,
      clientId: b.client.id,
      ref: 'hotel-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
      status: 'completed',
      priceMinor: 300_000,
      createdBy: 'client',
    });
    expect(await a.repo.stats.rows(0, 9e12)).toEqual([]);
    expect(await a.repo.clients.search('Иван')).toHaveLength(1); // its own client only
    expect(await a.repo.clients.count()).toBe(1);
  });
});

describe('schedule and availability', () => {
  it('reports appointments and time off as one list of busy spans', async () => {
    const { repo, master, service, client } = await seedTenant('busy');
    await repo.appointments.create({
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      ref: 'busy-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:15:00Z'),
      status: 'confirmed',
      createdBy: 'client',
    });
    await repo.schedule.addTimeOff(
      master.id,
      at('2024-06-05T13:00:00Z'),
      at('2024-06-05T15:00:00Z'),
      'обед',
    );

    const spans = await repo.appointments.busySpans(
      [master.id],
      at('2024-06-05T00:00:00Z').getTime(),
      at('2024-06-06T00:00:00Z').getTime(),
    );
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.endsAtMs - s.startsAtMs).sort()).toEqual([75 * 60_000, 120 * 60_000]);
  });

  it('leaves a cancelled appointment out of the busy spans', async () => {
    const { repo, master, service, client } = await seedTenant('busy2');
    const appt = await repo.appointments.create({
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      ref: 'busy2-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
      status: 'confirmed',
      createdBy: 'client',
    });
    await repo.appointments.transition(appt.id, ['confirmed'], 'cancelled_by_client');
    expect(await repo.appointments.busySpans([master.id], 0, 9e12)).toEqual([]);
  });

  it('replaces a weekday schedule wholesale', async () => {
    const { repo, master } = await seedTenant('wh');
    await repo.schedule.setWeekday(master.id, 3, [
      { startsLocal: '09:00', endsLocal: '13:00' },
      { startsLocal: '14:00', endsLocal: '18:00' },
    ]);
    expect(await repo.schedule.workingHoursFor(master.id)).toHaveLength(2);

    await repo.schedule.setWeekday(master.id, 3, [{ startsLocal: '10:00', endsLocal: '16:00' }]);
    const after = await repo.schedule.workingHoursFor(master.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.startsLocal).toBe('10:00:00');

    await repo.schedule.setWeekday(master.id, 3, []);
    expect(await repo.schedule.workingHoursFor(master.id)).toHaveLength(0);
  });
});

describe('appointment transitions', () => {
  it('only applies a transition from an expected status', async () => {
    const { repo, master, service, client } = await seedTenant('trans');
    const appt = await repo.appointments.create({
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      ref: 'trans-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
      status: 'confirmed',
      createdBy: 'client',
    });
    const cancelled = await repo.appointments.transition(
      appt.id,
      ['confirmed'],
      'cancelled_by_client',
      {
        cancelledAt: new Date(),
        cancelReason: 'заболел',
      },
    );
    expect(cancelled?.status).toBe('cancelled_by_client');

    // A second tap on the same button finds nothing to change.
    const again = await repo.appointments.transition(appt.id, ['confirmed'], 'cancelled_by_client');
    expect(again).toBeNull();
  });

  it('counts a client active future bookings for the anti-prank cap', async () => {
    const { repo, master, service, client } = await seedTenant('cap');
    const nowMs = at('2024-06-01T00:00:00Z').getTime();
    for (let i = 0; i < 3; i++) {
      await repo.appointments.create({
        staffId: master.id,
        serviceId: service.id,
        clientId: client.id,
        ref: `cap-${i}`,
        startsAt: at(`2024-06-0${i + 2}T09:00:00Z`),
        endsAt: at(`2024-06-0${i + 2}T10:00:00Z`),
        status: 'confirmed',
        createdBy: 'client',
      });
    }
    expect(await repo.appointments.activeFutureCountForClient(client.id, nowMs)).toBe(3);
  });

  it('meters bookings created inside a window for the free-tier limit', async () => {
    const { repo, master, service, client } = await seedTenant('meter');
    await repo.appointments.create({
      staffId: master.id,
      serviceId: service.id,
      clientId: client.id,
      ref: 'meter-1',
      startsAt: at('2024-06-05T09:00:00Z'),
      endsAt: at('2024-06-05T10:00:00Z'),
      status: 'confirmed',
      createdBy: 'client',
    });
    expect(await repo.appointments.countCreatedBetween(0, Date.now() + 60_000)).toBe(1);
    expect(await repo.appointments.countCreatedBetween(0, Date.now() - 60_000)).toBe(0);
  });
});

describe('clients', () => {
  it('upserts by (tenant, telegram id) rather than duplicating', async () => {
    const { repo } = await seedTenant('upsert');
    const first = await repo.clients.upsertTelegram({ telegramId: 777n, name: 'Иван' });
    const second = await repo.clients.upsertTelegram({
      telegramId: 777n,
      name: 'Иван Петров',
      username: 'ivan',
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Иван Петров');
    expect(await repo.clients.count()).toBe(2); // the seeded one plus this one
  });

  it('allows any number of manual clients, who have no telegram id', async () => {
    const { repo } = await seedTenant('manual');
    const a = await repo.clients.createManual({ name: 'Без телеграма', phone: '+79001112233' });
    const b = await repo.clients.createManual({ name: 'Тоже без' });
    expect(a.telegramId).toBeNull();
    expect(b.telegramId).toBeNull();
    // The partial unique index deliberately does not constrain NULL telegram ids.
    expect(a.id).not.toBe(b.id);
  });

  it('records consent, blocking and opt-out', async () => {
    const { repo, client } = await seedTenant('consent');
    expect(client.consentAt).toBeNull();
    await repo.clients.recordConsent(client.id);
    const after = await repo.clients.byId(client.id);
    expect(after?.consentAt).toBeInstanceOf(Date);

    await repo.clients.markBlocked(client.id);
    await repo.clients.optOut(client.id);
    const blocked = await repo.clients.byId(client.id);
    expect(blocked?.isBlocked).toBe(true);
    expect(blocked?.marketingOptOut).toBe(true);
  });

  it('searches by name and phone, case-insensitively', async () => {
    const { repo } = await seedTenant('search');
    await repo.clients.createManual({ name: 'Мария Иванова', phone: '+79005554433' });
    expect(await repo.clients.search('мария')).toHaveLength(1);
    expect(await repo.clients.search('5554433')).toHaveLength(1);
    expect(await repo.clients.search('никого')).toHaveLength(0);
    expect((await repo.clients.search('')).length).toBeGreaterThan(0);
  });
});

describe('telegram update idempotency', () => {
  it('ignores an update Telegram delivers twice', async () => {
    const { bot } = await seedTenant('idem');
    const updates = updateRepo(t.db);
    const first = await updates.record(bot.id, 42, { update_id: 42, message: { text: '/start' } });
    expect(first.duplicate).toBe(false);
    expect(first.row).not.toBeNull();

    const second = await updates.record(bot.id, 42, { update_id: 42, message: { text: '/start' } });
    expect(second.duplicate).toBe(true);
    expect(second.row).toBeNull();
  });

  it('scopes the update id to the bot that received it', async () => {
    const a = await seedTenant('idem-a');
    const b = await seedTenant('idem-b');
    const updates = updateRepo(t.db);
    expect((await updates.record(a.bot.id, 1, {})).duplicate).toBe(false);
    expect((await updates.record(b.bot.id, 1, {})).duplicate).toBe(false);
  });

  it('tracks processing for the staleness alert', async () => {
    const { bot } = await seedTenant('idem-proc');
    const updates = updateRepo(t.db);
    const { row } = await updates.record(bot.id, 7, {});
    expect(await updates.unprocessedCount()).toBe(1);
    expect(await updates.lastProcessedAt()).toBeNull();

    await updates.markProcessed(row?.id ?? 0);
    expect(await updates.unprocessedCount()).toBe(0);
    expect(await updates.lastProcessedAt()).toBeInstanceOf(Date);
  });
});

describe('job queue', () => {
  it('hands each job to exactly one of two competing workers', async () => {
    const jobs = jobRepo(t.db);
    for (let i = 0; i < 10; i++) {
      await jobs.enqueue({ kind: 'send_message', payload: { i } });
    }
    const [a, b] = await Promise.all([jobs.claim('worker-a', 10), jobs.claim('worker-b', 10)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('serves the most urgent job first', async () => {
    const jobs = jobRepo(t.db);
    await jobs.enqueue({ kind: 'broadcast_chunk', payload: {}, priority: 900 });
    await jobs.enqueue({ kind: 'send_message', payload: {}, priority: 10 });
    const claimed = await jobs.claim('w', 2);
    expect(claimed[0]?.kind).toBe('send_message');
  });

  it('does not serve a job before its time', async () => {
    const jobs = jobRepo(t.db);
    await jobs.enqueue({ kind: 'reminder', payload: {}, runAt: new Date(Date.now() + 3_600_000) });
    expect(await jobs.claim('w', 5)).toHaveLength(0);
    expect(await jobs.depth()).toBe(0);
  });

  it('drops a duplicate dedupe key instead of scheduling twice', async () => {
    const jobs = jobRepo(t.db);
    const first = await jobs.enqueue({
      kind: 'reminder',
      payload: {},
      dedupeKey: 'reminder:x:120',
    });
    const second = await jobs.enqueue({
      kind: 'reminder',
      payload: {},
      dedupeKey: 'reminder:x:120',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('extinguishes every unfinished job in a group', async () => {
    const jobs = jobRepo(t.db);
    const cancelKey = 'appt:11111111-2222-3333-4444-555555555555';
    await jobs.enqueue({
      kind: 'reminder',
      payload: { offsetMin: 1440 },
      cancelKey,
      dedupeKey: 'r1',
    });
    await jobs.enqueue({
      kind: 'reminder',
      payload: { offsetMin: 120 },
      cancelKey,
      dedupeKey: 'r2',
    });
    await jobs.enqueue({ kind: 'ask_no_show', payload: {}, cancelKey, dedupeKey: 'r3' });
    await jobs.enqueue({ kind: 'reminder', payload: {}, cancelKey: 'appt:other', dedupeKey: 'r4' });

    expect(await jobs.cancelByKey(cancelKey)).toBe(3);
    expect(await jobs.pendingByCancelKey(cancelKey)).toHaveLength(0);
    expect(await jobs.pendingByCancelKey('appt:other')).toHaveLength(1);

    // Cancelling twice is harmless and cancels nothing more.
    expect(await jobs.cancelByKey(cancelKey)).toBe(0);
  });

  it('retries with a later run_at and buries a job that runs out of attempts', async () => {
    const jobs = jobRepo(t.db);
    const created = await jobs.enqueue({ kind: 'send_message', payload: {}, maxAttempts: 2 });
    const id = created?.id ?? 0;

    const [claimed] = await jobs.claim('w', 1);
    expect(claimed?.attempts).toBe(1);

    const later = new Date(Date.now() + 120_000);
    expect(await jobs.fail(id, 'boom', later)).toBe('retry');
    expect((await jobs.byId(id))?.finishedAt).toBeNull();
    expect(await jobs.claim('w', 1)).toHaveLength(0); // not due yet

    expect(await jobs.fail(id, 'boom again', null)).toBe('dead');
    expect((await jobs.dead()).map((j) => j.id)).toContain(id);
  });

  it('lists a job that exhausted its attempts as dead, but not a cancelled one', async () => {
    const jobs = jobRepo(t.db);
    const doomed = await jobs.enqueue({
      kind: 'send_message',
      payload: {},
      maxAttempts: 1,
      dedupeKey: 'd1',
    });
    await jobs.claim('w', 1);
    await jobs.fail(doomed?.id ?? 0, 'permanent failure', null);

    const cancelled = await jobs.enqueue({
      kind: 'reminder',
      payload: {},
      cancelKey: 'appt:z',
      dedupeKey: 'd2',
    });
    await jobs.cancelByKey('appt:z');

    const dead = await jobs.dead();
    expect(dead.map((j) => j.id)).toEqual([doomed?.id]);
    expect(dead.map((j) => j.id)).not.toContain(cancelled?.id);
  });

  it('clears the error when a retried job finally succeeds', async () => {
    const jobs = jobRepo(t.db);
    const created = await jobs.enqueue({ kind: 'send_message', payload: {}, maxAttempts: 5 });
    const id = created?.id ?? 0;
    await jobs.claim('w', 1);
    await jobs.fail(id, 'transient', new Date(Date.now() - 1000));
    await jobs.claim('w', 1);
    await jobs.succeed(id);

    const row = await jobs.byId(id);
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
    expect(await jobs.dead()).toHaveLength(0);
  });

  it('reclaims a job whose worker died holding the lock', async () => {
    const jobs = jobRepo(t.db);
    await jobs.enqueue({ kind: 'send_message', payload: {} });
    const claimed = await jobs.claim('dead-worker', 1);
    expect(claimed).toHaveLength(1);
    expect(await jobs.claim('live-worker', 1)).toHaveLength(0);

    // Ten minutes later the lock is considered stale.
    const later = new Date(Date.now() + 10 * 60_000);
    const reclaimed = await jobs.claim('live-worker', 1, later);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it('inserts a batch and skips the ones that collide', async () => {
    const jobs = jobRepo(t.db);
    expect(await jobs.enqueueMany([])).toBe(0);
    expect(
      await jobs.enqueueMany([
        { kind: 'broadcast_chunk', payload: { i: 0 }, dedupeKey: 'b0' },
        { kind: 'broadcast_chunk', payload: { i: 1 }, dedupeKey: 'b1' },
      ]),
    ).toBe(2);
    expect(
      await jobs.enqueueMany([
        { kind: 'broadcast_chunk', payload: { i: 1 }, dedupeKey: 'b1' },
        { kind: 'broadcast_chunk', payload: { i: 2 }, dedupeKey: 'b2' },
      ]),
    ).toBe(1);
  });

  it('prunes finished jobs', async () => {
    const jobs = jobRepo(t.db);
    const created = await jobs.enqueue({ kind: 'send_message', payload: {} });
    await jobs.succeed(created?.id ?? 0);
    expect(await jobs.pruneFinishedBefore(new Date(Date.now() + 1000))).toBe(1);
  });
});

describe('session storage', () => {
  it('survives a process restart, unlike an in-memory store', async () => {
    const storage = pgSessionStorage<{ step: string }>(t.db);
    expect(await storage.read('user:1')).toBeUndefined();

    await storage.write('user:1', { step: 'awaiting_title' });
    expect(await storage.read('user:1')).toEqual({ step: 'awaiting_title' });

    await storage.write('user:1', { step: 'awaiting_timezone' });
    expect(await storage.read('user:1')).toEqual({ step: 'awaiting_timezone' });

    await storage.delete('user:1');
    expect(await storage.read('user:1')).toBeUndefined();
  });
});

describe('media references', () => {
  it('stores only identifiers, never bytes, and invalidates them on a bot change', async () => {
    const { repo, bot, tenant } = await seedTenant('media');
    const ref = await repo.media.create({
      botId: bot.id,
      fileId: 'AgACAgIAAxkBAAI',
      fileUniqueId: 'AQADabc',
      kind: 'photo',
      caption: 'портфолио',
    });
    expect(ref.needsReupload).toBe(false);

    // Moving the tenant to its own bot makes every stored file_id useless.
    const newBot = await botRepo(t.db).create({
      mode: 'dedicated',
      username: 'own_bot',
      botHash: 'own_hash',
    });
    expect(await repo.media.invalidateForBotChange(newBot.id)).toBe(1);
    expect((await repo.media.byId(ref.id))?.needsReupload).toBe(true);
    // file_unique_id survives the move; it just cannot be downloaded.
    expect((await repo.media.byId(ref.id))?.fileUniqueId).toBe('AQADabc');
    expect(tenant.id).toBe(repo.tenantId);
  });
});

describe('error code helpers', () => {
  it('classifies by SQLSTATE rather than by message', async () => {
    const { bot } = await seedTenant('codes');
    let caught: unknown;
    try {
      await t.sql`INSERT INTO bot (mode, username, bot_hash) VALUES ('shared', ${bot.username}, 'another')`;
    } catch (e) {
      caught = e;
    }
    expect(pgErrorCode(caught)).toBe(PG_ERRORS.uniqueViolation);
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isExclusionViolation(caught)).toBe(false);
    expect(pgErrorCode(new Error('plain'))).toBeNull();
    expect(isUniqueViolation(null)).toBe(false);
  });
});
