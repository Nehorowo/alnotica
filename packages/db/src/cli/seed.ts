/**
 * Demo data: one tenant with four services, two masters, a full schedule, sixty
 * appointments across the previous month (with cancellations and no-shows so the
 * statistics screen has something to show) and twenty upcoming ones.
 *
 * Idempotent by slug: running it twice replaces the demo tenant rather than
 * accumulating duplicates.
 */
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { DateTime } from 'luxon';
import { createDb } from '../client.js';
import { migrate } from '../migrate.js';
import { botRepo } from '../repo/bots.js';
import { forTenant } from '../repo/tenant-scoped.js';
import { tenantRepo } from '../repo/tenants.js';

const SLUG = 'demo1234';
const TIMEZONE = 'Europe/Moscow';

const SERVICES = [
  { name: 'Стрижка <люкс>', durationMin: 60, bufferAfterMin: 15, priceMinor: 300_000 },
  { name: 'Мытьё и сушка', durationMin: 45, bufferAfterMin: 10, priceMinor: 180_000 },
  { name: 'Тримминг', durationMin: 90, bufferAfterMin: 15, priceMinor: 450_000 },
  { name: 'Когти и уши', durationMin: 30, bufferAfterMin: 0, priceMinor: 90_000 },
] as const;

const CLIENT_NAMES = [
  'Анна',
  'Мария',
  'Ольга',
  'Дмитрий',
  'Сергей',
  'Екатерина',
  'Наталья',
  'Павел',
  'Ирина',
  'Алексей',
  'Юлия',
  'Максим',
  'Светлана',
  'Андрей',
  'Татьяна',
];

/** Deterministic pseudo-randomness, so a demo looks the same every time. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const handle = createDb({ url, max: 2 });

try {
  await migrate(handle.sql);

  const tenants = tenantRepo(handle.db);
  const bots = botRepo(handle.db);

  const existing = await tenants.bySlug(SLUG);
  if (existing) {
    // Cascades through staff, services, clients and appointments.
    await handle.sql`DELETE FROM tenant WHERE id = ${existing.id}`;
    console.log('removed the previous demo tenant');
  }

  const username = process.env.BOT_USERNAME ?? 'AlnoticaBot';
  const bot =
    (await bots.byUsername(username)) ??
    (await bots.create({
      mode: 'shared',
      username,
      botHash: randomBytes(24).toString('base64url').slice(0, 32),
    }));

  const tenant = await tenants.create({
    slug: SLUG,
    title: 'Груминг у Ани',
    kind: 'grooming',
    timezone: TIMEZONE,
    botId: bot.id,
    address: 'Москва, ул. Примерная, 1',
    phone: '+79001234567',
  });
  await tenants.update(tenant.id, { plan: 'pro' });

  const repo = forTenant(handle.db, tenant.id);

  const masters = [
    await repo.staff.create({ telegramId: 100_000_000_001n, name: 'Аня', role: 'owner' }),
    await repo.staff.create({ telegramId: 100_000_000_002n, name: 'Борис', role: 'staff' }),
  ];

  const services = [];
  for (const [index, spec] of SERVICES.entries()) {
    services.push(
      await repo.services.create({
        name: spec.name,
        description: null,
        durationMin: spec.durationMin,
        bufferAfterMin: spec.bufferAfterMin,
        priceMinor: spec.priceMinor,
        currency: 'RUB',
        sortOrder: index,
      }),
    );
  }
  for (const master of masters) {
    for (const service of services) await repo.services.link(master.id, service.id);
    // Weekdays 10:00-14:00 and 15:00-19:00 — a lunch break, so the slot grid has
    // a hole in it and the DST and break tests have a realistic shape to match.
    for (const weekday of [1, 2, 3, 4, 5]) {
      await repo.schedule.setWeekday(master.id, weekday, [
        { startsLocal: '10:00', endsLocal: '14:00' },
        { startsLocal: '15:00', endsLocal: '19:00' },
      ]);
    }
    await repo.schedule.setWeekday(master.id, 6, [{ startsLocal: '11:00', endsLocal: '16:00' }]);
  }

  const clients = [];
  for (const [index, name] of CLIENT_NAMES.entries()) {
    const client = await repo.clients.upsertTelegram({
      telegramId: BigInt(200_000_000_000 + index),
      name,
    });
    await repo.clients.recordConsent(client.id);
    clients.push(client);
  }
  // Two clients the master typed in: they never get reminders, which is exactly
  // the case the UI has to explain.
  clients.push(
    await repo.clients.createManual({ name: 'Пётр (без Telegram)', phone: '+79005554433' }),
  );
  clients.push(await repo.clients.createManual({ name: 'Галина (без Telegram)' }));

  const random = makeRandom(20_240_605);
  const now = DateTime.now().setZone(TIMEZONE);

  /** Picks a free weekday slot on the half hour within the given day window. */
  function slotOn(day: DateTime, index: number): DateTime {
    const morning = index % 2 === 0;
    const hour = morning ? 10 + (index % 4) : 15 + (index % 4);
    return day.startOf('day').set({ hour, minute: index % 2 === 0 ? 0 : 30 });
  }

  let created = 0;
  let clientIndex = 0;

  /* Sixty appointments across the weeks behind us, with real outcomes. */
  for (let day = 60; day >= 1 && created < 60; day--) {
    const date = now.minus({ days: day });
    if (date.weekday > 6) continue;

    for (let slot = 0; slot < 3 && created < 60; slot++) {
      const at = slotOn(date, created);
      const service = services[created % services.length];
      const master = masters[created % masters.length];
      const client = clients[clientIndex++ % clients.length];
      if (!service || !master || !client) continue;

      const roll = random();
      // Roughly 8% no-show and 10% cancellation: what a tenant with reminders
      // switched on actually looks like, so the statistics screen is believable.
      const status = roll < 0.08 ? 'no_show' : roll < 0.18 ? 'cancelled_by_client' : 'completed';

      try {
        await repo.appointments.create({
          staffId: master.id,
          serviceId: service.id,
          clientId: client.id,
          ref: `demo${created.toString().padStart(4, '0')}`,
          startsAt: at.toJSDate(),
          endsAt: at.plus({ minutes: service.durationMin + service.bufferAfterMin }).toJSDate(),
          status,
          priceMinor: status === 'completed' ? service.priceMinor : null,
          createdBy: 'client',
        });
        if (status === 'completed') {
          await repo.reminders.record({
            appointmentId:
              (await repo.appointments.byRef(`demo${created.toString().padStart(4, '0')}`))?.id ??
              '',
            offsetMin: 1440,
            delivered: true,
            sentAt: at.minus({ hours: 24 }).toJSDate(),
          });
        }
        created++;
      } catch {
        // An overlap with an earlier demo row: skip it and move on.
      }
    }
  }

  /* Twenty upcoming appointments. */
  let upcoming = 0;
  for (let day = 1; day <= 20 && upcoming < 20; day++) {
    const date = now.plus({ days: day });
    if (date.weekday > 6) continue;

    for (let slot = 0; slot < 2 && upcoming < 20; slot++) {
      const at = slotOn(date, upcoming + 7);
      const service = services[upcoming % services.length];
      const master = masters[(upcoming + 1) % masters.length];
      const client = clients[clientIndex++ % clients.length];
      if (!service || !master || !client) continue;

      try {
        await repo.appointments.create({
          staffId: master.id,
          serviceId: service.id,
          clientId: client.id,
          ref: `demoup${upcoming.toString().padStart(3, '0')}`,
          startsAt: at.toJSDate(),
          endsAt: at.plus({ minutes: service.durationMin + service.bufferAfterMin }).toJSDate(),
          status: 'confirmed',
          priceMinor: service.priceMinor,
          createdBy: 'client',
        });
        upcoming++;
      } catch {
        // Overlap: skip.
      }
    }
  }

  console.log(`seeded tenant "${tenant.title}" (${SLUG})`);
  console.log(
    `  services: ${services.length}, staff: ${masters.length}, clients: ${clients.length}`,
  );
  console.log(`  past appointments: ${created}, upcoming: ${upcoming}`);
  console.log(`  booking link: https://t.me/${bot.username}?start=m_${SLUG}`);
} catch (e) {
  console.error('seed failed:', e);
  process.exitCode = 1;
} finally {
  await handle.close();
}
