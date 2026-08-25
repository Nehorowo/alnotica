import { describe, expect, it } from 'vitest';
import {
  bigintStringSchema,
  currencySchema,
  epochMsSchema,
  humanNameSchema,
  isoDateSchema,
  localTimeSchema,
  paginationSchema,
  phoneSchema,
  priceMinorSchema,
  telegramIdSchema,
  timezoneSchema,
  uuidSchema,
} from './common.js';
import {
  audienceFilterSchema,
  createAppointmentSchema,
  createBroadcastSchema,
  createServiceSchema,
  createTenantSchema,
  manualClientSchema,
  mediaRefSchema,
  statsRangeSchema,
  telegramClientSchema,
  tenantSettingsSchema,
  timeOffSchema,
  workingHoursEntrySchema,
} from './entities.js';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('telegramIdSchema', () => {
  it('accepts a string id beyond 2^53 without losing a digit', () => {
    expect(telegramIdSchema.parse('9007199254740993')).toBe(9_007_199_254_740_993n);
  });

  it('accepts a bigint and a safe number', () => {
    expect(telegramIdSchema.parse(123n)).toBe(123n);
    expect(telegramIdSchema.parse(123)).toBe(123n);
    expect(telegramIdSchema.parse(-1_001_234_567n)).toBe(-1_001_234_567n);
  });

  it('refuses a number that has already been rounded', () => {
    // biome-ignore lint/correctness/noPrecisionLoss: an already-rounded literal is the input under test
    expect(telegramIdSchema.safeParse(9_007_199_254_740_995).success).toBe(false);
  });

  it('refuses anything that is not an integer', () => {
    expect(telegramIdSchema.safeParse('12.5').success).toBe(false);
    expect(telegramIdSchema.safeParse('abc').success).toBe(false);
    expect(telegramIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('common scalars', () => {
  it('validates uuids, dates and times', () => {
    expect(uuidSchema.safeParse(UUID).success).toBe(true);
    expect(uuidSchema.safeParse('nope').success).toBe(false);
    expect(isoDateSchema.safeParse('2024-06-05').success).toBe(true);
    expect(isoDateSchema.safeParse('05.06.2024').success).toBe(false);
    expect(localTimeSchema.safeParse('09:30').success).toBe(true);
    expect(localTimeSchema.safeParse('9:30').success).toBe(false);
  });

  it('accepts real IANA zones and rejects invented ones', () => {
    expect(timezoneSchema.safeParse('Europe/Moscow').success).toBe(true);
    expect(timezoneSchema.safeParse('Asia/Nicosia').success).toBe(true);
    expect(timezoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });

  it('keeps money as integer minor units', () => {
    expect(priceMinorSchema.safeParse(300_000).success).toBe(true);
    expect(priceMinorSchema.safeParse(3000.5).success).toBe(false);
    expect(priceMinorSchema.safeParse(-1).success).toBe(false);
    expect(currencySchema.safeParse('RUB').success).toBe(true);
    expect(currencySchema.safeParse('BTC').success).toBe(false);
  });

  it('normalizes names and phones', () => {
    expect(humanNameSchema.parse('  Анна   Петрова ')).toBe('Анна Петрова');
    expect(humanNameSchema.safeParse('   ').success).toBe(false);
    expect(phoneSchema.parse('+7 (900) 123-45-67')).toBe('+79001234567');
    expect(phoneSchema.safeParse('123').success).toBe(false);
  });

  it('renders bigints for the wire and clamps pagination', () => {
    expect(bigintStringSchema.parse(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(bigintStringSchema.parse(7)).toBe('7');
    expect(paginationSchema.parse({})).toEqual({ page: 0, perPage: 8 });
    expect(paginationSchema.parse({ page: '3', perPage: '20' })).toEqual({ page: 3, perPage: 20 });
    expect(paginationSchema.safeParse({ perPage: 500 }).success).toBe(false);
    expect(epochMsSchema.safeParse(-1).success).toBe(false);
  });
});

describe('tenant and service input', () => {
  it('accepts a plausible registration', () => {
    const parsed = createTenantSchema.parse({
      title: '  Груминг у Ани ',
      kind: 'grooming',
      timezone: 'Europe/Moscow',
    });
    expect(parsed.title).toBe('Груминг у Ани');
  });

  it('rejects an unknown business kind or zone', () => {
    const base = { title: 'X', kind: 'grooming', timezone: 'Europe/Moscow' };
    expect(createTenantSchema.safeParse({ ...base, kind: 'spaceship' }).success).toBe(false);
    expect(createTenantSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('defaults service buffer, price and currency', () => {
    const svc = createServiceSchema.parse({ name: 'Стрижка', durationMin: 60 });
    expect(svc).toMatchObject({
      bufferAfterMin: 0,
      priceMinor: null,
      currency: 'RUB',
      sortOrder: 0,
    });
  });

  it('rejects an implausible duration', () => {
    expect(createServiceSchema.safeParse({ name: 'X', durationMin: 1 }).success).toBe(false);
    expect(createServiceSchema.safeParse({ name: 'X', durationMin: 24 * 60 }).success).toBe(false);
  });

  it('only allows slot steps a calendar can render', () => {
    const base = {
      slotStepMin: 30,
      minLeadTimeMin: 120,
      bookingHorizonDays: 30,
      cancelWindowHours: 4,
      reminderOffsetsMin: [1440, 120],
    };
    expect(tenantSettingsSchema.parse(base).autoConfirm).toBe(true);
    expect(tenantSettingsSchema.safeParse({ ...base, slotStepMin: 7 }).success).toBe(false);
    expect(tenantSettingsSchema.safeParse({ ...base, reminderOffsetsMin: [1, 2] }).success).toBe(
      false,
    );
    expect(tenantSettingsSchema.safeParse({ ...base, bookingHorizonDays: 0 }).success).toBe(false);
  });
});

describe('schedule input', () => {
  it('rejects an interval that ends before it starts', () => {
    expect(
      workingHoursEntrySchema.safeParse({ weekday: 1, startsLocal: '09:00', endsLocal: '18:00' })
        .success,
    ).toBe(true);
    expect(
      workingHoursEntrySchema.safeParse({ weekday: 1, startsLocal: '18:00', endsLocal: '09:00' })
        .success,
    ).toBe(false);
    expect(
      workingHoursEntrySchema.safeParse({ weekday: 7, startsLocal: '09:00', endsLocal: '18:00' })
        .success,
    ).toBe(false);
  });

  it('rejects a zero-length time off', () => {
    expect(timeOffSchema.safeParse({ startsAtMs: 10, endsAtMs: 10 }).success).toBe(false);
    expect(
      timeOffSchema.safeParse({ startsAtMs: 10, endsAtMs: 20, reason: 'отпуск' }).success,
    ).toBe(true);
  });
});

describe('client, appointment, media and broadcast input', () => {
  it('accepts a manual client without a Telegram account', () => {
    expect(manualClientSchema.parse({ name: 'Иван', phone: '+7 900 111 22 33' }).phone).toBe(
      '+79001112233',
    );
  });

  it('requires a telegram id for a deep-link client', () => {
    expect(telegramClientSchema.safeParse({ name: 'Иван' }).success).toBe(false);
    expect(telegramClientSchema.parse({ name: 'Иван', telegramId: '42' }).telegramId).toBe(42n);
  });

  it('defaults the appointment creator to the client', () => {
    const appt = createAppointmentSchema.parse({ serviceId: UUID, staffId: UUID, startsAtMs: 1 });
    expect(appt.createdBy).toBe('client');
    expect(
      createAppointmentSchema.safeParse({ serviceId: UUID, staffId: UUID, startsAtMs: 0 }).success,
    ).toBe(false);
  });

  it('validates a media reference we only ever store by id', () => {
    expect(
      mediaRefSchema.safeParse({ fileId: 'AgAC', fileUniqueId: 'AQAD', kind: 'photo' }).success,
    ).toBe(true);
    expect(
      mediaRefSchema.safeParse({ fileId: '', fileUniqueId: 'AQAD', kind: 'photo' }).success,
    ).toBe(false);
    expect(
      mediaRefSchema.safeParse({ fileId: 'A', fileUniqueId: 'B', kind: 'hologram' }).success,
    ).toBe(false);
  });

  it('only accepts audiences we can compute ourselves', () => {
    expect(audienceFilterSchema.safeParse({ kind: 'all' }).success).toBe(true);
    expect(audienceFilterSchema.safeParse({ kind: 'not_visited_for', days: 45 }).success).toBe(
      true,
    );
    expect(audienceFilterSchema.safeParse({ kind: 'used_service', serviceId: UUID }).success).toBe(
      true,
    );
    // No way to hand us a list of chat ids.
    expect(audienceFilterSchema.safeParse({ kind: 'chat_ids', ids: ['1'] }).success).toBe(false);
  });

  it('bounds broadcast text and defaults the media reference', () => {
    const bc = createBroadcastSchema.parse({ text: 'Привет!', audience: { kind: 'all' } });
    expect(bc.mediaId).toBeNull();
    expect(createBroadcastSchema.safeParse({ text: '', audience: { kind: 'all' } }).success).toBe(
      false,
    );
    expect(
      createBroadcastSchema.safeParse({ text: 'x'.repeat(3001), audience: { kind: 'all' } })
        .success,
    ).toBe(false);
  });

  it('validates a stats range', () => {
    expect(statsRangeSchema.safeParse({ from: '2024-06-01', to: '2024-06-30' }).success).toBe(true);
    expect(statsRangeSchema.safeParse({ from: 'june', to: '2024-06-30' }).success).toBe(false);
  });
});
