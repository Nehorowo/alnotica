/**
 * Reminders and their extinction.
 *
 * The single most damaging bug this product can ship is reminding a client about
 * an appointment they cancelled. These tests exist to make that impossible to
 * reintroduce quietly.
 */
import { cancelBooking, createBooking, recordOutcome, rescheduleBooking } from '@alnotica/core';
import { appointmentCancelKey, planReminders } from '@alnotica/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../apps/worker/src/runner.js';
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
  h.now = DateTime.fromISO('2024-06-03T09:00', { zone: 'Europe/Moscow' }).toMillis(); // Monday
});

const deps = () => ({ db: h.db.db, queue: h.queue, nowMs: h.now });

/** Wednesday 14:00 local — two days out, so both reminders are in the future. */
function slotMs(f: Fixture, dayOffset = 2, hour = 14): number {
  return DateTime.fromMillis(h.now, { zone: f.tenant.timezone })
    .plus({ days: dayOffset })
    .startOf('day')
    .set({ hour })
    .toMillis();
}

async function bookOne(f: Fixture, startsAtMs = slotMs(f)) {
  return createBooking(deps(), {
    tenant: f.tenant,
    service: f.service,
    staff: f.staff,
    client: f.client,
    startsAtMs,
    createdBy: 'client',
  });
}

const pending = (appointmentId: string) =>
  jobs(h).pendingByCancelKey(appointmentCancelKey(appointmentId));

describe('scheduling', () => {
  it('schedules both reminders and the no-show question', async () => {
    const f = await seed(h);
    const { appointment, remindersScheduled } = await bookOne(f);
    expect(remindersScheduled).toBe(2);

    const queued = await pending(appointment.id);
    expect(queued.map((j) => j.kind).sort()).toEqual(['ask_no_show', 'reminder', 'reminder']);

    const reminders = queued.filter((j) => j.kind === 'reminder').map((j) => j.runAt.getTime());
    const startsAtMs = appointment.startsAt.getTime();
    expect(reminders.sort()).toEqual(
      [startsAtMs - 24 * 3_600_000, startsAtMs - 2 * 3_600_000].sort(),
    );
  });

  it('skips a reminder whose moment has already passed', async () => {
    const f = await seed(h);
    // Booked three hours out: the 24-hour reminder can never fire.
    const { appointment, remindersScheduled } = await bookOne(
      f,
      h.now + 3 * 3_600_000 - (h.now % 1_800_000),
    );
    expect(remindersScheduled).toBe(1);
    const queued = await pending(appointment.id);
    expect(queued.filter((j) => j.kind === 'reminder')).toHaveLength(1);
  });

  it('schedules no reminders for a client the bot cannot message', async () => {
    const f = await seed(h);
    const manual = await f.repo.clients.createManual({ name: 'Пётр', phone: '+79001112233' });

    const { remindersScheduled, clientReachable, appointment } = await createBooking(deps(), {
      tenant: f.tenant,
      service: f.service,
      staff: f.staff,
      client: manual,
      startsAtMs: slotMs(f),
      createdBy: 'staff',
      force: true,
    });

    expect(clientReachable).toBe(false);
    expect(remindersScheduled).toBe(0);
    // The no-show question still goes out: that one is addressed to the master.
    expect((await pending(appointment.id)).map((j) => j.kind)).toEqual(['ask_no_show']);
  });

  it('does not schedule for a client who never accepted the notice', async () => {
    const f = await seed(h, { consent: false });
    const { remindersScheduled } = await bookOne(f);
    expect(remindersScheduled).toBe(0);
  });

  it('agrees with the pure planner', async () => {
    const f = await seed(h);
    const startsAtMs = slotMs(f);
    const { appointment } = await bookOne(f, startsAtMs);

    const expected = planReminders({
      startsAtMs,
      nowMs: h.now,
      offsetsMin: f.tenant.reminderOffsetsMin,
      clientReachable: true,
    });
    const actual = (await pending(appointment.id))
      .filter((j) => j.kind === 'reminder')
      .map((j) => j.runAt.getTime())
      .sort();
    expect(actual).toEqual(expected.map((r) => r.runAtMs).sort());
  });
});

describe('cancellation extinguishes every reminder', () => {
  it('leaves nothing scheduled after the client cancels', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    expect(await pending(appointment.id)).toHaveLength(3);

    const { jobsCancelled } = await cancelBooking(deps(), {
      tenant: f.tenant,
      appointmentId: appointment.id,
      by: 'client',
    });

    expect(jobsCancelled).toBe(3);
    expect(await pending(appointment.id)).toHaveLength(0);
  });

  it('leaves nothing scheduled after the master cancels', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    await cancelBooking(deps(), { tenant: f.tenant, appointmentId: appointment.id, by: 'staff' });
    expect(await pending(appointment.id)).toHaveLength(0);
  });

  it('sends nothing even if a reminder job somehow survives', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);

    // Cancel through the database only, leaving the jobs behind: this simulates a
    // future code path that forgets to call cancelAppointmentJobs.
    await f.repo.appointments.transition(appointment.id, ['confirmed'], 'cancelled_by_client');

    const survivor = (await pending(appointment.id)).find((j) => j.kind === 'reminder');
    expect(survivor).toBeDefined();

    h.telegram.reset();
    // The handler re-reads the appointment and refuses to remind a cancelled one.
    await expect(
      runJob(h.jobCtx, { kind: 'reminder', appointmentId: appointment.id, offsetMin: 120 }),
    ).rejects.toThrow(/cancelled_by_client/);
    expect(h.telegram.callsTo('sendMessage')).toHaveLength(0);
  });

  it('extinguishes the old jobs and schedules new ones on a reschedule', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    const newStart = slotMs(f, 3, 11);

    const { previous, created, jobsCancelled } = await rescheduleBooking(deps(), {
      tenant: f.tenant,
      appointmentId: appointment.id,
      newStartsAtMs: newStart,
      by: 'client',
    });

    expect(jobsCancelled).toBe(3);
    expect(previous.status).toBe('rescheduled');
    expect(created.rescheduledFromId).toBe(appointment.id);
    expect(await pending(appointment.id)).toHaveLength(0);

    const fresh = await pending(created.id);
    expect(fresh.map((j) => j.kind).sort()).toEqual(['ask_no_show', 'reminder', 'reminder']);
    expect(created.startsAt.getTime()).toBe(newStart);
  });

  it('puts the original back when the new time turns out to be taken', async () => {
    const f = await seed(h);
    const first = await bookOne(f, slotMs(f, 2, 14));

    // A second client occupies the time the first one wants to move to.
    const other = await f.repo.clients.upsertTelegram({
      telegramId: 4_000_000_001n,
      name: 'Мария',
    });
    await f.repo.clients.recordConsent(other.id);
    const target = slotMs(f, 3, 11);
    await createBooking(deps(), {
      tenant: f.tenant,
      service: f.service,
      staff: f.staff,
      client: other,
      startsAtMs: target,
      createdBy: 'client',
    });

    await expect(
      rescheduleBooking(deps(), {
        tenant: f.tenant,
        appointmentId: first.appointment.id,
        newStartsAtMs: target,
        by: 'client',
      }),
    ).rejects.toThrow();

    // The client must not be left with no appointment at all.
    const restored = await f.repo.appointments.byId(first.appointment.id);
    expect(restored?.status).toBe('confirmed');
    expect((await pending(first.appointment.id)).length).toBeGreaterThan(0);
  });

  it('extinguishes reminders when the master records the outcome early', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    await recordOutcome(deps(), {
      tenant: f.tenant,
      appointmentId: appointment.id,
      outcome: 'no_show',
    });
    expect(await pending(appointment.id)).toHaveLength(0);
    expect((await f.repo.appointments.byId(appointment.id))?.status).toBe('no_show');
  });
});

describe('reminder delivery', () => {
  it('sends the reminder and records the delivery', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);

    await runJob(h.jobCtx, { kind: 'reminder', appointmentId: appointment.id, offsetMin: 1440 });

    const sent = h.telegram.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.chat_id)).toBe(f.client.telegramId?.toString());
    expect(String(sent[0]?.body.text)).toContain('Стрижка &lt;люкс&gt;'); // escaped, not broken
    expect(sent[0]?.body.parse_mode).toBe('HTML');

    const stats = await f.repo.reminders.deliveryStats(0, h.now + 1e10);
    expect(stats.remindersSent).toBe(1);
  });

  it('offers confirm, reschedule and cancel on the reminder', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    await runJob(h.jobCtx, { kind: 'reminder', appointmentId: appointment.id, offsetMin: 120 });

    const markup = h.telegram.callsTo('sendMessage')[0]?.body.reply_markup as
      | { inline_keyboard: { text: string }[][] }
      | undefined;
    const labels = markup?.inline_keyboard.flat().map((b) => b.text) ?? [];
    expect(labels).toContain('Подтверждаю');
    expect(labels).toContain('Перенести');
    expect(labels).toContain('Отменить');
  });

  it('counts a client confirmation towards the delivery report', async () => {
    const f = await seed(h);
    const { appointment } = await bookOne(f);
    await f.repo.appointments.transition(appointment.id, ['confirmed'], 'confirmed', {
      confirmedByClientAt: new Date(h.now),
    });

    const stats = await f.repo.reminders.deliveryStats(h.now - 86_400_000, h.now + 30 * 86_400_000);
    expect(stats.remindersConfirmed).toBe(1);
  });
});
