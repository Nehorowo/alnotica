import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  EncryptionError,
  InitDataError,
  InvalidTransitionError,
  NotFoundError,
  OutsideCancelWindowError,
  PlanFeatureError,
  PlanLimitError,
  SlotNotAvailableError,
  SlotTakenError,
  TelegramApiError,
  isDomainError,
} from './errors.js';

describe('error hierarchy', () => {
  it('names every error after its own class, so logs are readable', () => {
    expect(new SlotTakenError(123).name).toBe('SlotTakenError');
    expect(new InitDataError('bad hash').name).toBe('InitDataError');
  });

  it('separates what a user may see from what they may not', () => {
    const domain = [
      new SlotTakenError(),
      new SlotNotAvailableError('too_soon'),
      new OutsideCancelWindowError(4),
      new InvalidTransitionError('completed', 'confirm'),
      new PlanLimitError(30, 30),
      new PlanFeatureError('broadcasts'),
      new NotFoundError('tenant'),
    ];
    for (const e of domain) {
      expect(e.userFacing).toBe(true);
      expect(isDomainError(e)).toBe(true);
      expect(e.code).toMatch(/^[a-z_]+$/);
    }

    const infra = [
      new InitDataError('expired'),
      new ConfigError('DATABASE_URL missing'),
      new EncryptionError('bad key length'),
      new TelegramApiError('too many requests', 429, 12),
    ];
    for (const e of infra) {
      expect(e.userFacing).toBe(false);
      expect(isDomainError(e)).toBe(false);
    }
  });

  it('carries the details a handler needs to react', () => {
    expect(new SlotTakenError(42).startsAtMs).toBe(42);
    expect(new SlotNotAvailableError('beyond_horizon').reason).toBe('beyond_horizon');
    expect(new OutsideCancelWindowError(6).cancelWindowHours).toBe(6);
    expect(new PlanLimitError(30, 31)).toMatchObject({ limit: 30, used: 31 });
    const tg = new TelegramApiError('flood', 429, 12);
    expect(tg).toMatchObject({ statusCode: 429, retryAfterSec: 12 });
  });

  it('is catchable as a plain Error', () => {
    expect(new SlotTakenError()).toBeInstanceOf(Error);
    expect(() => {
      throw new NotFoundError('service');
    }).toThrow(/service not found/);
  });
});
