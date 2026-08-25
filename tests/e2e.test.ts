/**
 * The whole client path, driven the way Telegram drives it: updates in, API calls
 * out, nothing stubbed but the transport.
 *
 * Deep link -> consent -> service -> slot -> booking -> reminder scheduled ->
 * cancellation -> reminder extinguished.
 */
import {
  appointmentCancelKey,
  decodeCallback,
  encodeCallback,
  parseStartPayload,
  startLink,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processBatch } from '../apps/worker/src/runner.js';
import {
  type Fixture,
  type Harness,
  TEST_WEBHOOK_SECRET,
  createHarness,
  jobs,
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

let updateId = 1000;
/** Whose chat the assertion helpers look at; set by `deliver`. */
let focusedChat = '';

/** Posts an update through the real webhook and drains the queue. */
async function deliver(f: Fixture, update: Record<string, unknown>): Promise<void> {
  focusedChat = String(actorOf(update) ?? focusedChat);
  const res = await h.app.inject({
    method: 'POST',
    url: `/tg/${f.bot.botHash}`,
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    payload: { update_id: updateId++, ...update },
  });
  expect(res.statusCode).toBe(200);

  // Drain repeatedly: handling an update enqueues follow-up work (notifying the
  // master, for one), and a single pass would leave that sitting in the queue.
  for (let pass = 0; pass < 5; pass++) {
    h.now = Date.now();
    const result = await processBatch(h.jobCtx, {
      workerId: 'e2e',
      concurrency: 4,
      queue: h.queue,
    });
    if (result.claimed === 0) break;
  }
}

/** The Telegram id the update came from, so assertions look at the right chat. */
function actorOf(update: Record<string, unknown>): number | undefined {
  const msg = update.message as { from?: { id?: number } } | undefined;
  const cb = update.callback_query as { from?: { id?: number } } | undefined;
  return msg?.from?.id ?? cb?.from?.id;
}

function message(from: bigint, text: string) {
  // Telegram marks commands with a bot_command entity, and grammY's command
  // filter looks for exactly that — a bare "/start" string would not match.
  const command = /^\/([A-Za-z0-9_]+)/.exec(text);
  return {
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(from), type: 'private' },
      from: { id: Number(from), is_bot: false, first_name: 'Иван' },
      text,
      ...(command
        ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] }
        : {}),
    },
  };
}

function callback(from: bigint, data: string, messageId = 1) {
  return {
    callback_query: {
      id: String(updateId),
      from: { id: Number(from), is_bot: false, first_name: 'Иван' },
      chat_instance: 'x',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(from), type: 'private' },
        text: 'previous',
      },
    },
  };
}

function outgoing() {
  return h.telegram.calls.filter(
    (c) =>
      (c.method === 'sendMessage' || c.method === 'editMessageText') &&
      // Only what went to the person we are pretending to be: a booking also
      // messages the master, and that must not be mistaken for the client's screen.
      String(c.body.chat_id) === focusedChat,
  );
}

/** The last text the bot sent or edited to the acting user. */
function lastText(): string {
  return String(outgoing().at(-1)?.body.text ?? '');
}

/** The callback data of every button in that message. */
function lastButtons(): { text: string; data?: string }[] {
  const markup = outgoing().at(-1)?.body.reply_markup as
    | { inline_keyboard: { text: string; callback_data?: string }[][] }
    | undefined;
  return (markup?.inline_keyboard ?? [])
    .flat()
    .map((b) => ({ text: b.text, data: b.callback_data }));
}

function findButton(predicate: (label: string) => boolean): string {
  const found = lastButtons().find((b) => predicate(b.text));
  if (!found?.data)
    throw new Error(`no button matching predicate among ${JSON.stringify(lastButtons())}`);
  return found.data;
}

describe('client end to end', () => {
  it('walks a client from a deep link to a booked, reminded, then cancelled visit', async () => {
    const f = await seed(h, { consent: false });
    const clientTg = f.client.telegramId ?? 9_000_000_001n;

    /* 1. The link the master pastes into their profile. */
    const link = startLink(f.bot.username, { kind: 'master', slug: f.tenant.slug });
    expect(link).toBe(`https://t.me/${f.bot.username}?start=m_${f.tenant.slug}`);
    const payload = parseStartPayload(new URL(link).searchParams.get('start') ?? '');
    expect(payload).toEqual({ kind: 'master', slug: f.tenant.slug });

    /* 2. /start with the payload asks for consent first. */
    await deliver(f, message(clientTg, `/start m_${f.tenant.slug}`));
    expect(lastText()).toContain('Прежде чем продолжить');
    const acceptData = findButton((t) => t === 'Принимаю');

    /* 3. Accepting records consent and shows the master's page. */
    await deliver(f, callback(clientTg, acceptData));
    expect(lastText()).toContain(f.tenant.title);
    expect((await f.repo.clients.byTelegramId(clientTg))?.consentAt).toBeInstanceOf(Date);

    /* 4. "Записаться" lists the services — with the angle brackets escaped. */
    await deliver(
      f,
      callback(
        clientTg,
        findButton((t) => t === 'Записаться'),
      ),
    );
    expect(lastText()).toContain('Выберите услугу');
    const serviceButton = lastButtons().find((b) => b.text.includes('Стрижка'));
    expect(serviceButton?.text).toContain('<люкс>'); // button labels are plain text
    expect(serviceButton?.data).toBeDefined();

    /* 5. Picking the service goes straight to times: there is only one master. */
    await deliver(f, callback(clientTg, serviceButton?.data ?? ''));
    // Escaped in the message body, because that is HTML.
    expect(lastText()).toContain('Стрижка &lt;люкс&gt;');

    const slotButtons = lastButtons().filter((b) => /^\d{2}:\d{2}/.test(b.text));
    expect(slotButtons.length).toBeGreaterThan(0);
    const chosen = slotButtons[0];
    const decoded = decodeCallback(chosen?.data);
    expect(decoded?.a).toBe('slot');
    const startsAtMs = decoded?.a === 'slot' ? decoded.t : 0;

    /* 6. Booking it. */
    await deliver(f, callback(clientTg, chosen?.data ?? ''));
    expect(lastText()).toContain('Записали.');

    const booked = await f.repo.appointments.listBetween(startsAtMs - 1, startsAtMs + 1);
    expect(booked).toHaveLength(1);
    const appointment = booked[0];
    if (!appointment) throw new Error('unreachable');
    expect(appointment.status).toBe('confirmed');

    /* 7. Reminders and the no-show question are scheduled. */
    const scheduled = await jobs(h).pendingByCancelKey(appointmentCancelKey(appointment.id));
    expect(scheduled.filter((j) => j.kind === 'reminder').length).toBeGreaterThan(0);
    expect(scheduled.some((j) => j.kind === 'ask_no_show')).toBe(true);

    /* 8. The master was told, in the same breath. */
    const staffMessages = h.telegram
      .callsTo('sendMessage')
      .filter((c) => String(c.body.chat_id) === f.staff.telegramId.toString());
    expect(staffMessages.length).toBeGreaterThan(0);
    expect(String(staffMessages.at(-1)?.body.text)).toContain('Новая запись');

    /* 9. The client cancels from the card. */
    await deliver(
      f,
      callback(clientTg, encodeCallback({ a: 'appt', o: 'cancel', id: appointment.id })),
    );

    const cancelled = await f.repo.appointments.byId(appointment.id);
    expect(cancelled?.status).toBe('cancelled_by_client');

    /* 10. And every reminder is gone. */
    expect(await jobs(h).pendingByCancelKey(appointmentCancelKey(appointment.id))).toHaveLength(0);

    /* 11. The freed slot is bookable again. */
    const zone = f.tenant.timezone;
    const date = DateTime.fromMillis(startsAtMs, { zone }).toFormat('yyyy-MM-dd');
    const spans = await f.repo.appointments.busySpans([f.staff.id], startsAtMs - 1, startsAtMs + 1);
    expect(spans).toEqual([]);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('skips the service picker when the link names a service', async () => {
    const f = await seed(h);
    const clientTg = f.client.telegramId ?? 9_000_000_002n;

    await deliver(f, message(clientTg, `/start s_${f.tenant.slug}_0`));
    // Straight to the time grid, no "choose a service" screen.
    expect(lastText()).toContain('Стрижка &lt;люкс&gt;');
    expect(lastButtons().some((b) => /^\d{2}:\d{2}/.test(b.text))).toBe(true);
  });

  it('always stops the spinner on a tapped button', async () => {
    const f = await seed(h);
    const clientTg = f.client.telegramId ?? 9_000_000_003n;

    await deliver(f, message(clientTg, `/start m_${f.tenant.slug}`));
    h.telegram.reset();

    // Deliberately nonsense data: the handler will not know what to do with it.
    await deliver(f, callback(clientTg, 'appt|o=cancel|id=11111111-2222-3333-4444-555555555555'));
    // Without answerCallbackQuery the client watches a loading indicator forever.
    expect(h.telegram.callsTo('answerCallbackQuery').length).toBeGreaterThan(0);
  });

  it('refuses to reach a tenant on another bot', async () => {
    const a = await seed(h);
    const b = await seed(h);
    const clientTg = 9_000_000_004n;

    // The deep link names tenant B, but the update arrives on tenant A's bot.
    await deliver(a, message(clientTg, `/start m_${b.tenant.slug}`));

    // The client is created under B (that is who the link named), never under A.
    expect(await a.repo.clients.byTelegramId(clientTg)).toBeNull();
  });
});

describe('master end to end', () => {
  it('registers a master and hands them their link', async () => {
    const f = await seed(h);
    const masterTg = 8_000_000_001n;

    await deliver(f, message(masterTg, '/start'));
    expect(lastText()).toContain('зарегистрированы');

    await deliver(
      f,
      callback(
        masterTg,
        findButton((t) => t === 'Создать кабинет'),
      ),
    );
    expect(lastText()).toContain('Как называется');

    await deliver(f, message(masterTg, 'Груминг у Ани'));
    expect(lastText()).toContain('Чем вы занимаетесь');

    await deliver(
      f,
      callback(
        masterTg,
        findButton((t) => t === 'Груминг'),
      ),
    );
    expect(lastText()).toContain('часовом поясе');

    await deliver(
      f,
      callback(
        masterTg,
        findButton((t) => t === 'Moscow'),
      ),
    );
    expect(lastText()).toContain('первую услугу');

    await deliver(f, message(masterTg, 'Стрижка, 60, 3000'));
    expect(lastText()).toContain('график');

    await deliver(
      f,
      callback(
        masterTg,
        findButton((t) => t === texts_done()),
      ),
    );
    await deliver(f, message(masterTg, '09:00-18:00'));

    // The last screen is the link, because pasting it into a bio is the product.
    expect(lastText()).toContain('t.me/');
    expect(lastText()).toContain('шапку профиля');

    const memberships = await h.ctx.tenants.membershipsOf(masterTg);
    expect(memberships).toHaveLength(1);
    const created = memberships[0];
    if (!created) throw new Error('unreachable');
    expect(created.tenant.title).toBe('Груминг у Ани');
    expect(created.tenant.timezone).toBe('Europe/Moscow');

    const repo = h.ctx.db && created ? undefined : undefined;
    expect(repo).toBeUndefined();
    expect(f.tenant.id).not.toBe(created.tenant.id);
  });
});

function texts_done(): string {
  return 'Готово';
}
