/**
 * Placeholder for two-way calendar synchronisation. The interface exists so that
 * the booking flow already has a seam to call into; there is deliberately no
 * implementation in the MVP (see NON-GOALS).
 */
export interface ExternalEvent {
  readonly externalId: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly title: string;
}

export interface CalendarSync {
  readonly provider: string;
  /** Events that block time on the master's calendar but did not originate here. */
  pullBusy(staffId: string, fromMs: number, toMs: number): Promise<ExternalEvent[]>;
  push(staffId: string, event: ExternalEvent): Promise<string>;
  remove(staffId: string, externalId: string): Promise<void>;
}

/** The only implementation shipped in the MVP: a no-op. */
export const noCalendarSync: CalendarSync = {
  provider: 'none',
  async pullBusy() {
    return [];
  },
  async push(_staffId, event) {
    return event.externalId;
  },
  async remove() {
    /* nothing to remove */
  },
};
