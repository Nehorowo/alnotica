/**
 * Crockford base32 without the visually ambiguous letters I, L, O, U.
 * Used for tenant slugs and appointment refs, which end up inside deep-link
 * payloads (`?start=m_k3n7p2qa`) where the alphabet is limited to [A-Za-z0-9_-].
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const SLUG_LENGTH = 8;

export type RandomBytes = (n: number) => Uint8Array;

const webCrypto: Crypto | undefined =
  typeof globalThis.crypto !== 'undefined' && 'getRandomValues' in globalThis.crypto
    ? globalThis.crypto
    : undefined;

const defaultRandomBytes: RandomBytes = (n) => {
  const buf = new Uint8Array(n);
  if (!webCrypto) throw new Error('no CSPRNG available');
  webCrypto.getRandomValues(buf);
  return buf;
};

/** Generates a lowercase slug of `length` Crockford-base32 characters. */
export function generateSlug(
  length = SLUG_LENGTH,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // Modulo bias over a 32-symbol alphabet from 256 values is exactly zero (256 % 32 === 0).
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out.toLowerCase();
}

const SLUG_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{4,16}$/;

export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Normalizes user-typed slugs: Crockford treats O as 0 and I/L as 1. */
export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[oO]/g, '0')
    .replace(/[iIlL]/g, '1')
    .replace(/[uU]/g, 'v');
}
