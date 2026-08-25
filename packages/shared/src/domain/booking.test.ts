import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, OutsideCancelWindowError } from '../errors.js';
import { APPOINTMENT_STATUSES, isBlockingStatus, isTerminalStatus } from '../types/index.js';
import {
  APPOINTMENT_ACTIONS,
  allowedActions,
  askNoShowAtMs,
  assertClientMayCancel,
  canTransition,
  correctOutcome,
  countsAsNoShow,
  initialStatus,
  isCancelled,
  isWithinCancelWindow,
  nextStatus,
  pendingExpiresAtMs,
  releasesSlot,
} from './booking.js';

describe('nextStatus', () => {
  it('walks the happy path', () => {
    expect(nextStatus('pending', 'confirm')).toBe('confirmed');
    expect(nextStatus('confirmed', 'complete')).toBe('completed');
  });

  it('handles every cancellation route', () => {
    expect(nextStatus('pending', 'cancel_by_client')).toBe('cancelled_by_client');
    expect(nextStatus('pending', 'cancel_by_staff')).toBe('cancelled_by_staff');
    expect(nextStatus('confirmed', 'cancel_by_client')).toBe('cancelled_by_client');
    expect(nextStatus('confirmed', 'cancel_by_staff')).toBe('cancelled_by_staff');
    expect(nextStatus('pending', 'expire')).toBe('expired');
    expect(nextStatus('confirmed', 'mark_no_show')).toBe('no_show');
    expect(nextStatus('confirmed', 'reschedule')).toBe('rescheduled');
    expect(nextStatus('pending', 'reschedule')).toBe('rescheduled');
  });

  it('rejects nonsense transitions', () => {
    expect(() => nextStatus('pending', 'complete')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('pending', 'mark_no_show')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('confirmed', 'confirm')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('confirmed', 'expire')).toThrow(InvalidTransitionError);
  });

  it('accepts nothing at all from a terminal status', () => {
    const terminal = APPOINTMENT_STATUSES.filter(isTerminalStatus);
    expect(terminal.length).toBeGreaterThan(0);
    for (const status of terminal) {
      for (const action of APPOINTMENT_ACTIONS) {
        expect(() => nextStatus(status, action)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('carries the offending pair on the error', () => {
    try {
      nextStatus('completed', 'confirm');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe('completed');
      expect(err.action).toBe('confirm');
      expect(err.userFacing).toBe(true);
    }
  });
});

describe('canTransition / allowedActions', () => {
  it('agrees with nextStatus', () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const action of APPOINTMENT_ACTIONS) {
        let ok = true;
        try {
          nextStatus(status, action);
        } catch {
          ok = false;
        }
        expect(canTransition(status, action)).toBe(ok);
      }
    }
  });

  it('lists what a pending appointment can do', () => {
    expect(allowedActions('pending').sort()).toEqual(
      ['cancel_by_client', 'cancel_by_staff', 'expire', 'confirm', 'reschedule'].sort(),
    );
    expect(allowedActions('no_show')).toEqual([]);
  });
});

describe('correctOutcome', () => {
  it('lets the master fix a mistaken verdict', () => {
    expect(correctOutcome('no_show', 'completed')).toBe('completed');
    expect(correctOutcome('completed', 'no_show')).toBe('no_show');
  });

  it('refuses to resurrect a cancellation', () => {
    expect(() => correctOutcome('cancelled_by_client', 'completed')).toThrow(
      InvalidTransitionError,
    );
    expect(() => correctOutcome('confirmed', 'no_show')).toThrow(InvalidTransitionError);
  });
});

describe('cancel window', () => {
  const startsAtMs = Date.UTC(2024, 5, 5, 12, 0);

  it('allows a cancellation comfortably ahead of time', () => {
    expect(
      isWithinCancelWindow({ startsAtMs, nowMs: startsAtMs - 5 * 3_600_000, cancelWindowHours: 4 }),
    ).toBe(true);
  });

  it('allows one exactly on the boundary', () => {
    expect(
      isWithinCancelWindow({ startsAtMs, nowMs: startsAtMs - 4 * 3_600_000, cancelWindowHours: 4 }),
    ).toBe(true);
  });

  it('refuses one a minute too late', () => {
    const check = { startsAtMs, nowMs: startsAtMs - 4 * 3_600_000 + 60_000, cancelWindowHours: 4 };
    expect(isWithinCancelWindow(check)).toBe(false);
    expect(() => assertClientMayCancel(check)).toThrow(OutsideCancelWindowError);
  });

  it('treats a zero window as always open', () => {
    expect(isWithinCancelWindow({ startsAtMs, nowMs: startsAtMs, cancelWindowHours: 0 })).toBe(
      true,
    );
  });
});

describe('derived timings and predicates', () => {
  it('expires a pending appointment an hour after creation', () => {
    expect(pendingExpiresAtMs(0)).toBe(60 * 60_000);
    expect(pendingExpiresAtMs(0, 15)).toBe(15 * 60_000);
  });

  it('asks about the no-show two hours after the visit ends', () => {
    expect(askNoShowAtMs(0)).toBe(120 * 60_000);
  });

  it('picks the initial status from autoConfirm', () => {
    expect(initialStatus(true)).toBe('confirmed');
    expect(initialStatus(false)).toBe('pending');
  });

  it('keeps blocking statuses and slot release in agreement', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(releasesSlot(status)).toBe(!isBlockingStatus(status));
    }
  });

  it('classifies outcomes', () => {
    expect(countsAsNoShow('no_show')).toBe(true);
    expect(countsAsNoShow('completed')).toBe(false);
    expect(isCancelled('cancelled_by_staff')).toBe(true);
    expect(isCancelled('expired')).toBe(false);
  });
});
