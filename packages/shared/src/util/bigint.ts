/**
 * `JSON.stringify` throws on bigint ("Do not know how to serialize a BigInt").
 * Telegram user ids can exceed 2^53, so they live as bigint in the domain and as
 * decimal strings on the wire. Everything crossing a JSON boundary goes through here.
 */

/** Replacer that renders bigint as a decimal string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Drop-in `JSON.stringify` that tolerates bigint anywhere in the tree. */
export function jsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}

/** Recursively converts bigint values to strings, leaving everything else alone. */
export function toJsonSafe<T>(value: T): JsonSafe<T> {
  if (typeof value === 'bigint') return value.toString() as JsonSafe<T>;
  if (Array.isArray(value)) return value.map(toJsonSafe) as JsonSafe<T>;
  if (value instanceof Date) return value as JsonSafe<T>;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out as JsonSafe<T>;
  }
  return value as JsonSafe<T>;
}

export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? Date
    : T extends readonly (infer U)[]
      ? JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T;

const DECIMAL = /^-?\d+$/;

/** Parses a Telegram id from anything the wire may hand us, refusing lossy numbers. */
export function parseTelegramId(input: unknown): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new TypeError(`telegram id ${input} is not a safe integer; pass it as a string`);
    }
    return BigInt(input);
  }
  if (typeof input === 'string' && DECIMAL.test(input)) return BigInt(input);
  throw new TypeError(`cannot parse telegram id from ${typeof input}`);
}
