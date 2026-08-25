/**
 * Secrets at rest and unguessable identifiers.
 *
 * A dedicated bot's token is the tenant's whole Telegram presence: with it,
 * anyone can read every conversation their clients have with the bot. It is
 * encrypted with AES-256-GCM, and it never appears in a log line or an API
 * response.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { EncryptionError } from '@alnotica/shared';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Accepts the key as base64, hex or 32 raw characters. */
export function parseEncryptionKey(raw: string): Buffer {
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(raw)) candidates.push(Buffer.from(raw, 'hex'));
  if (/^[A-Za-z0-9+/=_-]{43,}$/.test(raw)) candidates.push(Buffer.from(raw, 'base64'));
  candidates.push(Buffer.from(raw, 'utf8'));

  const key = candidates.find((b) => b.length === KEY_BYTES);
  if (!key) throw new EncryptionError(`encryption key must decode to ${KEY_BYTES} bytes`);
  return key;
}

/**
 * Envelope layout: `iv (12) || ciphertext || tag (16)`.
 * One buffer, one column, no separate nonce table to keep in sync.
 */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new EncryptionError('bad key length');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]);
}

export function decryptSecret(envelope: Buffer, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new EncryptionError('bad key length');
  if (envelope.length < IV_BYTES + TAG_BYTES + 1) throw new EncryptionError('envelope too short');
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const body = envelope.subarray(IV_BYTES, envelope.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (e) {
    // A failed tag check means the ciphertext was tampered with or the key rotated.
    throw new EncryptionError('could not decrypt secret', { cause: e });
  }
}

const HASH_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The `/tg/:botHash` path segment. Deliberately random rather than derived from
 * the token: a derived path would leak whenever the hash function is known.
 */
export function generateBotHash(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) out += HASH_ALPHABET[randomInt(HASH_ALPHABET.length)];
  return out;
}

/** Constant-time comparison for the webhook secret header. */
export function secretMatches(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
