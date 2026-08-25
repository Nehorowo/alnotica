/**
 * `initData` handling that does not need a CSPRNG — everything up to, but not
 * including, the HMAC. The HMAC itself lives in the API (node:crypto) so this
 * module stays bundleable for the browser.
 */
import { z } from 'zod';
import { InitDataError } from '../errors.js';

/** 15 minutes for anything that writes. */
export const WRITE_MAX_AGE_SEC = 900;
/** 24 hours for read-only calls, so a Mini App left open still renders. */
export const READ_MAX_AGE_SEC = 86_400;

export const initDataUserSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  is_bot: z.boolean().optional(),
  first_name: z.string().default(''),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  photo_url: z.string().optional(),
});

export type InitDataUser = z.infer<typeof initDataUserSchema>;

/**
 * Builds the string Telegram signs.
 *
 * The sort must be by code point. `localeCompare` is locale-dependent and will
 * order `auth_date` and `chat_instance` differently on different machines,
 * producing a signature mismatch that only shows up in production.
 */
export function buildDataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export interface SplitInitData {
  readonly hash: string;
  readonly dataCheckString: string;
  readonly params: URLSearchParams;
}

/**
 * Splits raw `initData` into the claimed hash and the string it must match.
 * `signature` (the Ed25519 third-party validation field) is excluded — it is not
 * part of the HMAC input.
 */
export function splitInitData(initData: string): SplitInitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('no hash');
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new InitDataError('malformed hash');
  params.delete('hash');
  params.delete('signature');
  return { hash: hash.toLowerCase(), dataCheckString: buildDataCheckString(params), params };
}

/** Throws when `auth_date` is missing, unparseable, in the future, or too old. */
export function assertFreshAuthDate(
  params: URLSearchParams,
  maxAgeSec: number,
  nowMs: number,
): void {
  const raw = params.get('auth_date');
  const authDate = Number(raw);
  if (!raw || !Number.isFinite(authDate) || authDate <= 0) throw new InitDataError('no auth_date');
  const ageSec = nowMs / 1000 - authDate;
  // A little clock skew in our favour is fine; a lot means a forged timestamp.
  if (ageSec < -300) throw new InitDataError('auth_date in the future');
  if (ageSec > maxAgeSec) throw new InitDataError('expired');
}

/** Extracts and validates the `user` field. `user.id` is the only identity we use. */
export function parseInitDataUser(params: URLSearchParams): InitDataUser {
  const raw = params.get('user');
  if (!raw) throw new InitDataError('no user');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InitDataError('user is not json');
  }
  const parsed = initDataUserSchema.safeParse(json);
  if (!parsed.success) throw new InitDataError('user is malformed');
  return parsed.data;
}

/** The launch parameter passed through `startapp=`, if any. */
export function initDataStartParam(params: URLSearchParams): string | null {
  return params.get('start_param');
}
