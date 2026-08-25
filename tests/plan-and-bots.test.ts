/**
 * The one runtime billing check, and the dedicated-bot handoff.
 */
import {
  attachDedicatedBot,
  createBooking,
  decryptSecret,
  encryptSecret,
  looksLikeBotToken,
  parseEncryptionKey,
} from '@alnotica/core';
import {
  EncryptionError,
  FREE_MONTHLY_APPOINTMENTS,
  PlanFeatureError,
  PlanLimitError,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixture,
  type Harness,
  TEST_ENCRYPTION_KEY,
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
  h.now = Date.now();
});

const deps = () => ({ db: h.db.db, queue: h.queue, nowMs: h.now });

/** A weekday 14:00 slot `days` out. */
function slotMs(f: Fixture, days: number): number {
  let dt = DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
    .plus({ days })
    .startOf('day')
    .set({ hour: 14 });
  while (dt.weekday > 5) dt = dt.plus({ days: 1 });
  return dt.toMillis();
}

describe('free tier', () => {
  it('stops new client bookings once the month is spent, and says why', async () => {
    const f = await seed(h);

    // Fill the month's allowance directly, without going through the grid.
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at, status, created_by)
      SELECT ${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id},
             'seed-' || g, ${new Date(h.now - 40 * 86_400_000).toISOString()}::timestamptz + (g || ' hours')::interval,
             ${new Date(h.now - 40 * 86_400_000).toISOString()}::timestamptz + (g || ' hours')::interval + interval '30 minutes',
             'completed', 'client'
        FROM generate_series(1, ${FREE_MONTHLY_APPOINTMENTS}) g
    `;

    await expect(
      createBooking(deps(), {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs: slotMs(f, 2),
        createdBy: 'client',
      }),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('lets existing appointments and the master keep working past the limit', async () => {
    const f = await seed(h);
    await h.db.sql`
      INSERT INTO appointment (tenant_id, staff_id, service_id, client_id, ref, starts_at, ends_at, status, created_by)
      SELECT ${f.tenant.id}, ${f.staff.id}, ${f.service.id}, ${f.client.id},
             'seed2-' || g, ${new Date(h.now - 40 * 86_400_000).toISOString()}::timestamptz + (g || ' hours')::interval,
             ${new Date(h.now - 40 * 86_400_000).toISOString()}::timestamptz + (g || ' hours')::interval + interval '30 minutes',
             'completed', 'client'
        FROM generate_series(1, ${FREE_MONTHLY_APPOINTMENTS}) g
    `;

    // The master is not blocked: only bookings the client initiates are refused.
    await expect(
      createBooking(deps(), {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs: slotMs(f, 3),
        createdBy: 'staff',
        force: true,
      }),
    ).resolves.toBeTruthy();
  });

  it('does not limit a paid tenant', async () => {
    const f = await seed(h, { plan: 'pro' });
    await expect(
      createBooking(deps(), {
        tenant: f.tenant,
        service: f.service,
        staff: f.staff,
        client: f.client,
        startsAtMs: slotMs(f, 2),
        createdBy: 'client',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('token encryption', () => {
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY);
  const token = '123456789:AAExampleTokenForTestsOnly_0123456789';

  it('round-trips a token', () => {
    const envelope = encryptSecret(token, key);
    expect(decryptSecret(envelope, key)).toBe(token);
  });

  it('never leaves the plaintext anywhere in the envelope', () => {
    const envelope = encryptSecret(token, key);
    expect(envelope.toString('utf8')).not.toContain(token);
    expect(envelope.toString('utf8')).not.toContain('123456789');
  });

  it('uses a fresh nonce, so the same token encrypts differently each time', () => {
    expect(encryptSecret(token, key).equals(encryptSecret(token, key))).toBe(false);
  });

  it('refuses a tampered envelope rather than returning garbage', () => {
    const envelope = encryptSecret(token, key);
    // GCM authenticates the ciphertext: one flipped bit invalidates the whole thing.
    envelope[envelope.length - 20] ^= 0x01;
    expect(() => decryptSecret(envelope, key)).toThrow(EncryptionError);
  });

  it('refuses a wrong key', () => {
    const other = parseEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
    expect(() => decryptSecret(encryptSecret(token, key), other)).toThrow(EncryptionError);
  });

  it('accepts a key as hex, base64 or 32 raw characters, and nothing else', () => {
    expect(parseEncryptionKey(Buffer.alloc(32, 1).toString('hex'))).toHaveLength(32);
    expect(parseEncryptionKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
    expect(parseEncryptionKey('a'.repeat(32))).toHaveLength(32);
    expect(() => parseEncryptionKey('too short')).toThrow(EncryptionError);
  });

  it('rejects a truncated envelope', () => {
    expect(() => decryptSecret(Buffer.alloc(4), key)).toThrow(EncryptionError);
  });
});

describe('dedicated bot', () => {
  const token = '987654321:AADedicatedTokenForTests_0123456789';

  it('recognises the shape of a BotFather token', () => {
    expect(looksLikeBotToken(token)).toBe(true);
    expect(looksLikeBotToken('not a token')).toBe(false);
    expect(looksLikeBotToken('123:short')).toBe(false);
  });

  it('refuses the handoff on the free tier', async () => {
    const f = await seed(h);
    await expect(
      attachDedicatedBot({
        db: h.db.db,
        registry: h.registry,
        encryptionKey: parseEncryptionKey(TEST_ENCRYPTION_KEY),
        tenantId: f.tenant.id,
        token,
        publicUrl: null,
        webhookSecret: 'secret',
      }),
    ).rejects.toBeInstanceOf(PlanFeatureError);
  });

  it('stores the token encrypted, re-points the tenant, and flags stored media', async () => {
    const f = await seed(h, { plan: 'pro' });
    const media = await f.repo.media.create({
      botId: f.bot.id,
      fileId: 'AgACAgIAAxkBAAI',
      fileUniqueId: 'AQADabc',
      kind: 'photo',
    });

    const result = await attachDedicatedBot({
      db: h.db.db,
      registry: h.registry,
      encryptionKey: parseEncryptionKey(TEST_ENCRYPTION_KEY),
      tenantId: f.tenant.id,
      token,
      publicUrl: 'https://example.test',
      webhookSecret: 'secret-value-for-the-webhook-0001',
    });

    // The mock Bot API reports this username for getMe.
    expect(result.username).toBe('AlnoticaTestBot');
    expect(result.webhookPath).toMatch(/^\/tg\/[A-Za-z0-9]{32}$/);

    const stored = await h.ctx.bots.byId(result.bot.id);
    expect(stored?.mode).toBe('dedicated');
    // Encrypted at rest, and the plaintext appears nowhere in the row.
    expect(stored?.tokenEncrypted).toBeInstanceOf(Buffer);
    expect(Buffer.from(stored?.tokenEncrypted ?? []).toString('utf8')).not.toContain(token);
    expect(
      decryptSecret(
        Buffer.from(stored?.tokenEncrypted ?? []),
        parseEncryptionKey(TEST_ENCRYPTION_KEY),
      ),
    ).toBe(token);

    const tenant = await h.ctx.tenants.byId(f.tenant.id);
    expect(tenant?.botId).toBe(result.bot.id);

    // A file_id only works for the bot that received it, so every stored one is
    // now useless and the master has to upload again.
    expect(result.mediaInvalidated).toBe(1);
    expect((await f.repo.media.byId(media.id))?.needsReupload).toBe(true);
    // The stable id survives the move; it just cannot be downloaded.
    expect((await f.repo.media.byId(media.id))?.fileUniqueId).toBe('AQADabc');

    // The webhook was installed with the secret token.
    const setWebhook = h.telegram.callsTo('setWebhook');
    expect(setWebhook).toHaveLength(1);
    expect(String(setWebhook[0]?.body.url)).toContain(result.webhookPath);
    expect(setWebhook[0]?.body.secret_token).toBe('secret-value-for-the-webhook-0001');
  });

  it('rejects a token that is not a token before touching the database', async () => {
    const f = await seed(h, { plan: 'pro' });
    const before = await h.ctx.bots.listActive();
    await expect(
      attachDedicatedBot({
        db: h.db.db,
        registry: h.registry,
        encryptionKey: parseEncryptionKey(TEST_ENCRYPTION_KEY),
        tenantId: f.tenant.id,
        token: 'definitely-not-a-token',
        publicUrl: null,
        webhookSecret: 'secret',
      }),
    ).rejects.toThrow();
    expect(await h.ctx.bots.listActive()).toHaveLength(before.length);
  });
});
