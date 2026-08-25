/**
 * Typed error hierarchy. Domain errors are expected, user-visible situations;
 * infrastructure errors are bugs or outages. Never throw bare strings.
 */

export abstract class AppError extends Error {
  abstract readonly code: string;
  /** Safe to render to an end user (already localized where needed). */
  readonly userFacing: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/* ------------------------------ domain errors ----------------------------- */

export abstract class DomainError extends AppError {
  override readonly userFacing = true;
}

export class SlotTakenError extends DomainError {
  readonly code = 'slot_taken';
  constructor(readonly startsAtMs?: number) {
    super('slot is already taken');
  }
}

export class SlotNotAvailableError extends DomainError {
  readonly code = 'slot_not_available';
  constructor(
    readonly reason: 'outside_working_hours' | 'too_soon' | 'beyond_horizon' | 'not_on_grid',
  ) {
    super(`slot not available: ${reason}`);
  }
}

export class OutsideCancelWindowError extends DomainError {
  readonly code = 'outside_cancel_window';
  constructor(readonly cancelWindowHours: number) {
    super(`cancellation window of ${cancelWindowHours}h has passed`);
  }
}

export class InvalidTransitionError extends DomainError {
  readonly code = 'invalid_transition';
  constructor(
    readonly from: string,
    readonly action: string,
  ) {
    super(`cannot apply "${action}" to appointment in status "${from}"`);
  }
}

export class TooManyActiveAppointmentsError extends DomainError {
  readonly code = 'too_many_active_appointments';
  constructor(readonly limit: number) {
    super(`client already has ${limit} active future appointments`);
  }
}

export class PlanLimitError extends DomainError {
  readonly code = 'plan_limit';
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super(`free plan limit reached (${used}/${limit})`);
  }
}

export class PlanFeatureError extends DomainError {
  readonly code = 'plan_feature';
  constructor(readonly feature: string) {
    super(`feature "${feature}" is not available on the current plan`);
  }
}

export class BroadcastLimitError extends DomainError {
  readonly code = 'broadcast_limit';
  constructor(
    readonly reason: 'monthly_quota' | 'cooldown' | 'tenant_too_young' | 'empty_audience',
  ) {
    super(`broadcast rejected: ${reason}`);
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'rate_limited';
  constructor(readonly retryAfterSec: number) {
    super(`rate limited, retry after ${retryAfterSec}s`);
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found';
  constructor(readonly entity: string) {
    super(`${entity} not found`);
  }
}

/* -------------------------- infrastructure errors ------------------------- */

export abstract class InfraError extends AppError {}

export class InitDataError extends InfraError {
  readonly code = 'init_data_invalid';
  constructor(reason: string) {
    super(`initData invalid: ${reason}`);
  }
}

export class ConfigError extends InfraError {
  readonly code = 'config_invalid';
}

export class EncryptionError extends InfraError {
  readonly code = 'encryption_failed';
}

export class TelegramApiError extends InfraError {
  readonly code = 'telegram_api';
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
