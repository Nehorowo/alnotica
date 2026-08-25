/**
 * Tenant statistics. The no-show rate is the number the master is paying for, so
 * it is computed here once and reused by the bot, the digest and the Mini App.
 */
import type { AppointmentStatus } from '../types/index.js';

export interface StatsRow {
  readonly status: AppointmentStatus;
  readonly priceMinor: number | null;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly clientId: string;
  readonly isFirstVisit: boolean;
}

export interface DeliveryRow {
  readonly remindersSent: number;
  readonly remindersConfirmed: number;
}

export interface TenantStats {
  readonly total: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly noShow: number;
  /** Share of finished visits that the client did not attend, 0..1. */
  readonly noShowRate: number;
  readonly revenueMinor: number;
  readonly newClients: number;
  readonly returningClients: number;
  readonly topServices: readonly { serviceId: string; serviceName: string; count: number }[];
  readonly remindersSent: number;
  readonly remindersConfirmed: number;
}

/**
 * The denominator is deliberately "visits that reached a verdict" — completed
 * plus no-show. Counting cancellations in would dilute the metric the master
 * actually cares about: people who did not cancel and did not turn up.
 */
export function computeStats(rows: readonly StatsRow[], delivery: DeliveryRow): TenantStats {
  let completed = 0;
  let cancelled = 0;
  let noShow = 0;
  let revenueMinor = 0;
  const byService = new Map<string, { serviceId: string; serviceName: string; count: number }>();
  const clients = new Set<string>();
  const newClients = new Set<string>();

  for (const row of rows) {
    switch (row.status) {
      case 'completed':
        completed++;
        revenueMinor += row.priceMinor ?? 0;
        break;
      case 'no_show':
        noShow++;
        break;
      case 'cancelled_by_client':
      case 'cancelled_by_staff':
      case 'expired':
        cancelled++;
        break;
      case 'pending':
      case 'confirmed':
      case 'rescheduled':
        break;
      default:
        break;
    }
    const entry = byService.get(row.serviceId);
    if (entry) entry.count++;
    else
      byService.set(row.serviceId, {
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        count: 1,
      });
    clients.add(row.clientId);
    if (row.isFirstVisit) newClients.add(row.clientId);
  }

  const decided = completed + noShow;
  return {
    total: rows.length,
    completed,
    cancelled,
    noShow,
    noShowRate: decided === 0 ? 0 : noShow / decided,
    revenueMinor,
    newClients: newClients.size,
    returningClients: clients.size - newClients.size,
    topServices: [...byService.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    remindersSent: delivery.remindersSent,
    remindersConfirmed: delivery.remindersConfirmed,
  };
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits).replace(/\.0$/, '')}%`;
}

/**
 * Rough money recovered by reminders, used in the "this is what you pay for" line.
 * Assumes the industry baseline of 20% no-show without reminders.
 */
export const BASELINE_NO_SHOW_RATE = 0.2;

export function estimatedSavedMinor(stats: TenantStats, avgTicketMinor: number): number {
  const decided = stats.completed + stats.noShow;
  const expectedNoShows = decided * BASELINE_NO_SHOW_RATE;
  const prevented = Math.max(0, expectedNoShows - stats.noShow);
  return Math.round(prevented * avgTicketMinor);
}

export function averageTicketMinor(stats: TenantStats): number {
  return stats.completed === 0 ? 0 : Math.round(stats.revenueMinor / stats.completed);
}
