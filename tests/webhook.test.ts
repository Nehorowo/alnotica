/**
 * The webhook's two jobs: refuse anything that is not Telegram, and never lose
 * an update that is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Harness,
  TEST_WEBHOOK_SECRET,
  createHarness,
  jobs,
  seed,
  textUpdate,
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

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

describe('webhook authentication', () => {
  it('rejects a request with no secret header', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(res.statusCode).toBe(401);
    // No body: a prober learns nothing from the response.
    expect(res.body).toBe('');
  });

  it('rejects a wrong secret', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      headers: { [SECRET_HEADER]: 'not-the-secret-not-the-secret-000' },
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a secret of the right length but wrong content', async () => {
    const f = await seed(h);
    const wrong = `${TEST_WEBHOOK_SECRET.slice(0, -1)}X`;
    const res = await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      headers: { [SECRET_HEADER]: wrong },
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct secret and queues the update', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(res.statusCode).toBe(200);

    const claimed = await jobs(h).claim('t', 10);
    expect(claimed.map((j) => j.kind)).toEqual(['process_update']);
  });

  it('writes nothing when the secret is wrong', async () => {
    const f = await seed(h);
    await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(await h.ctx.updates.unprocessedCount()).toBe(0);
    expect(await jobs(h).depth()).toBe(0);
  });
});

describe('webhook idempotency', () => {
  it('processes a repeated update_id only once', async () => {
    const f = await seed(h);
    const update = textUpdate(4242, 555n, '/start');
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: `/tg/${f.bot.botHash}`,
        headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
        payload: update,
      });

    expect((await send()).statusCode).toBe(200);
    // Telegram retries whenever our answer was slow. The retry must be a no-op.
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);

    expect(await h.ctx.updates.unprocessedCount()).toBe(1);
    const claimed = await jobs(h).claim('t', 10);
    expect(claimed).toHaveLength(1);
  });

  it('keeps update ids separate per bot', async () => {
    const a = await seed(h);
    const b = await seed(h);
    for (const f of [a, b]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/tg/${f.bot.botHash}`,
        headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
        payload: textUpdate(7, 555n, '/start'),
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await h.ctx.updates.unprocessedCount()).toBe(2);
  });
});

describe('webhook robustness', () => {
  it('answers 200 for an unknown bot hash, so Telegram stops retrying', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/tg/thisbotdoesnotexistanywhere0000',
      headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
      payload: textUpdate(1, 555n, '/start'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers 200 for a body that is not an update', async () => {
    const f = await seed(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/tg/${f.bot.botHash}`,
      headers: { [SECRET_HEADER]: TEST_WEBHOOK_SECRET },
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(200);
    expect(await jobs(h).depth()).toBe(0);
  });
});

describe('health probes', () => {
  it('reports liveness and readiness', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, db: true });
  });
});
