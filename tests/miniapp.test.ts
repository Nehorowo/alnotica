/**
 * The Mini App API surface: signature verification, tenant isolation on every
 * route, and idempotent booking.
 */
import { randomUUID } from 'node:crypto';
import { signInitData } from '@alnotica/core';
import { IDEMPOTENCY_HEADER, INIT_DATA_HEADER } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixture,
  type Harness,
  TEST_BOT_TOKEN,
  createHarness,
  seed,
} from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

/** Signs initData for a given user, fresh by default. */
function initData(telegramId: bigint, options: { ageSec?: number; token?: string } = {}): string {
  const authDate = Math.floor(Date.now() / 1000) - (options.ageSec ?? 10);
  return signInitData(
    {
      auth_date: String(authDate),
      query_id: 'AAE',
      user: JSON.stringify({ id: telegramId.toString(), first_name: 'Иван', username: 'ivan' }),
    },
    options.token ?? TEST_BOT_TOKEN,
  );
}

function headers(initDataValue: string, extra: Record<string, string> = {}) {
  return { [INIT_DATA_HEADER]: initDataValue, ...extra };
}

/** A Wednesday 14:00 local, comfortably inside working hours and the horizon. */
function nextSlotMs(f: Fixture): number {
  const base = DateTime.now()
    .setZone(f.tenant.timezone)
    .plus({ days: 3 })
    .startOf('day')
    .set({ hour: 14 });
  const weekdayAdjusted = base.weekday >= 6 ? base.plus({ days: 8 - base.weekday }) : base;
  return weekdayAdjusted.toMillis();
}

describe('initData verification', () => {
  it('accepts a freshly signed payload', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().services).toHaveLength(1);
  });

  it('rejects a payload with a single byte changed', async () => {
    const f = await seed(h);
    const valid = initData(f.client.telegramId ?? 1n);
    const params = new URLSearchParams(valid);
    const hash = params.get('hash') ?? '';
    // Flip exactly one hex digit of the signature.
    const flipped = `${hash.slice(0, -1)}${hash.at(-1) === 'a' ? 'b' : 'a'}`;
    params.set('hash', flipped);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(params.toString()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a payload whose data was changed after signing', async () => {
    const f = await seed(h);
    const params = new URLSearchParams(initData(f.client.telegramId ?? 1n));
    // Same valid signature, different user: this is the attack the HMAC prevents.
    params.set('user', JSON.stringify({ id: '999', first_name: 'Мэллори' }));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(params.toString()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a payload signed with another bot token', async () => {
    const f = await seed(h);
    const other = initData(f.client.telegramId ?? 1n, {
      token: '987654321:AAAnotherTokenEntirely_9876543210',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(other),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale auth_date on a write but tolerates it on a read', async () => {
    const f = await seed(h);
    const stale = initData(f.client.telegramId ?? 1n, { ageSec: 1000 }); // > 15 min

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(stale),
    });
    expect(read.statusCode).toBe(200);

    const write = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/book`,
      headers: headers(stale),
      payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs: nextSlotMs(f) },
    });
    expect(write.statusCode).toBe(401);
  });

  it('rejects a payload older than a day even for a read', async () => {
    const f = await seed(h);
    const ancient = initData(f.client.telegramId ?? 1n, { ageSec: 90_000 });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
      headers: headers(ancient),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no initData at all', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/services`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('answers 404, never 403, for every route asked about another tenant ids', async () => {
    const a = await seed(h);
    const b = await seed(h);
    const caller = initData(a.staff.telegramId);

    const from = DateTime.now().setZone(a.tenant.timezone).toFormat('yyyy-MM-dd');
    const to = DateTime.now().setZone(a.tenant.timezone).plus({ days: 7 }).toFormat('yyyy-MM-dd');

    // Tenant A's slug, tenant B's service id.
    const availability = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${a.tenant.slug}/availability?serviceId=${b.service.id}&staffId=${b.staff.id}&from=${from}&to=${to}`,
      headers: headers(caller),
    });
    expect(availability.statusCode).toBe(404);
    expect(availability.json().error.code).toBe('not_found');

    // Tenant A's slug, tenant B's staff id, A's own service.
    const wrongStaff = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${a.tenant.slug}/availability?serviceId=${a.service.id}&staffId=${b.staff.id}&from=${from}&to=${to}`,
      headers: headers(caller),
    });
    expect(wrongStaff.statusCode).toBe(404);

    const book = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${a.tenant.slug}/book`,
      headers: headers(caller),
      payload: { serviceId: b.service.id, staffId: b.staff.id, startsAtMs: nextSlotMs(a) },
    });
    expect(book.statusCode).toBe(404);

    const staffBook = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${a.tenant.slug}/staff-book`,
      headers: headers(caller),
      payload: {
        serviceId: b.service.id,
        staffId: b.staff.id,
        startsAtMs: nextSlotMs(a),
        clientName: 'Пётр',
      },
    });
    expect(staffBook.statusCode).toBe(404);
  });

  it('refuses the staff schedule to someone who is staff elsewhere', async () => {
    const a = await seed(h);
    const b = await seed(h);
    const from = DateTime.now().setZone(b.tenant.timezone).toFormat('yyyy-MM-dd');

    // A's master, holding perfectly valid initData, asking about B's calendar.
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${b.tenant.slug}/schedule?from=${from}&to=${from}`,
      headers: headers(initData(a.staff.telegramId)),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses the staff schedule to a mere client', async () => {
    const f = await seed(h);
    const from = DateTime.now().setZone(f.tenant.timezone).toFormat('yyyy-MM-dd');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/schedule?from=${from}&to=${from}`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for a tenant that does not exist', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/miniapp/nosuchtenant/services',
      headers: headers(initData(f.client.telegramId ?? 1n)),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('availability', () => {
  it('returns a grid the client can render', async () => {
    const f = await seed(h);
    const zone = f.tenant.timezone;
    const from = DateTime.now().setZone(zone).plus({ days: 1 }).toFormat('yyyy-MM-dd');
    const to = DateTime.now().setZone(zone).plus({ days: 7 }).toFormat('yyyy-MM-dd');

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/availability?serviceId=${f.service.id}&staffId=${f.staff.id}&from=${from}&to=${to}`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant.timezone).toBe(zone);
    expect(body.days).toHaveLength(7);
    expect(body.days.some((d: { slots: unknown[] }) => d.slots.length > 0)).toBe(true);
  });

  it('rejects a malformed date range', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/availability?serviceId=${f.service.id}&from=nope&to=nope`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('booking', () => {
  it('creates one appointment and returns it', async () => {
    const f = await seed(h);
    const startsAtMs = nextSlotMs(f);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/book`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
      payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.appointment.startsAtMs).toBe(startsAtMs);
    expect(body.replayed).toBe(false);
  });

  it('returns the same appointment for a repeated Idempotency-Key', async () => {
    const f = await seed(h);
    const startsAtMs = nextSlotMs(f);
    const key = randomUUID();
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: `/api/miniapp/${f.tenant.slug}/book`,
        headers: headers(initData(f.client.telegramId ?? 1n), { [IDEMPOTENCY_HEADER]: key }),
        payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs },
      });

    const first = await send();
    expect(first.statusCode).toBe(201);

    // A retry on a flaky connection, or a double tap.
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().appointment.id).toBe(first.json().appointment.id);

    const all = await f.repo.appointments.listBetween(startsAtMs - 1, startsAtMs + 1);
    expect(all).toHaveLength(1);
  });

  it('offers alternatives instead of a bare error when the slot is gone', async () => {
    const f = await seed(h);
    const startsAtMs = nextSlotMs(f);
    const book = (telegramId: bigint) =>
      h.app.inject({
        method: 'POST',
        url: `/api/miniapp/${f.tenant.slug}/book`,
        headers: headers(initData(telegramId)),
        payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs },
      });

    expect((await book(f.client.telegramId ?? 1n)).statusCode).toBe(201);

    const second = await book(3_000_000_001n);
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error.code).toBe('slot_taken');
    expect(Array.isArray(body.error.alternatives)).toBe(true);
    expect(body.error.alternatives.length).toBeGreaterThan(0);
    expect(
      body.error.alternatives.every((s: { startsAtMs: number }) => s.startsAtMs !== startsAtMs),
    ).toBe(true);
  });

  it('refuses a time that is not on the published grid', async () => {
    const f = await seed(h);
    const offGrid = nextSlotMs(f) + 7 * 60_000;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/book`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
      payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs: offGrid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slot_not_available');
  });

  it('caps how many future bookings one client may hold', async () => {
    const f = await seed(h);
    const base = nextSlotMs(f);
    const telegramId = f.client.telegramId ?? 1n;

    for (let i = 0; i < 3; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/miniapp/${f.tenant.slug}/book`,
        headers: headers(initData(telegramId)),
        payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs: base + i * 3_600_000 },
      });
      expect(res.statusCode).toBe(201);
    }

    const fourth = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/book`,
      headers: headers(initData(telegramId)),
      payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs: base + 4 * 3_600_000 },
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('too_many_active_appointments');
  });
});

describe('staff schedule and manual booking', () => {
  it('lets a master see their own week', async () => {
    const f = await seed(h);
    const zone = f.tenant.timezone;
    const from = DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
    const to = DateTime.now().setZone(zone).plus({ days: 7 }).toFormat('yyyy-MM-dd');

    await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/book`,
      headers: headers(initData(f.client.telegramId ?? 1n)),
      payload: { serviceId: f.service.id, staffId: f.staff.id, startsAtMs: nextSlotMs(f) },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/miniapp/${f.tenant.slug}/schedule?from=${from}&to=${to}`,
      headers: headers(initData(f.staff.telegramId)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().appointments).toHaveLength(1);
  });

  it('books a client who has no Telegram and says so', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/staff-book`,
      headers: headers(initData(f.staff.telegramId)),
      payload: {
        serviceId: f.service.id,
        staffId: f.staff.id,
        startsAtMs: nextSlotMs(f),
        clientName: 'Пётр',
        clientPhone: '+79001112233',
      },
    });
    expect(res.statusCode).toBe(201);
    // The flag the UI uses to explain why no reminders will be sent.
    expect(res.json().clientReachable).toBe(false);
  });

  it('lets a master book outside the published grid', async () => {
    const f = await seed(h);
    // 21:30 on a working day: past closing time, but the master decides.
    const late = DateTime.now()
      .setZone(f.tenant.timezone)
      .plus({ days: 3 })
      .startOf('day')
      .set({ hour: 21, minute: 30 });
    const adjusted = late.weekday >= 6 ? late.plus({ days: 8 - late.weekday }) : late;

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/miniapp/${f.tenant.slug}/staff-book`,
      headers: headers(initData(f.staff.telegramId)),
      payload: {
        serviceId: f.service.id,
        staffId: f.staff.id,
        startsAtMs: adjusted.toMillis(),
        clientName: 'Пётр',
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
