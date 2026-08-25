/**
 * A tiny in-process TTL map. Deliberately not Redis: with one box and a 60-second
 * horizon, a second service to run and monitor buys nothing.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAtMs: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, nowMs = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, nowMs = Date.now()): void {
    this.entries.set(key, { value, expiresAtMs: nowMs + this.ttlMs });
  }

  /** Drops every key that starts with `prefix`; used when a schedule changes. */
  invalidatePrefix(prefix: string): number {
    let dropped = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
  }

  sweep(nowMs = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
