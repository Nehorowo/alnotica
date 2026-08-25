/**
 * `initData` verification.
 *
 * The order of the two HMAC calls is the classic mistake here: the secret is
 * `HMAC_SHA256(key = "WebAppData", message = botToken)`, and the check is
 * `HMAC_SHA256(key = secret, message = dataCheckString)`. Swapping them produces
 * a function that rejects everything, including valid data.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  InitDataError,
  type InitDataUser,
  READ_MAX_AGE_SEC,
  WRITE_MAX_AGE_SEC,
  assertFreshAuthDate,
  initDataStartParam,
  parseInitDataUser,
  splitInitData,
} from '@alnotica/shared';

export interface VerifiedInitData {
  readonly user: InitDataUser;
  readonly startParam: string | null;
  readonly authDate: number;
  readonly queryId: string | null;
}

export interface VerifyOptions {
  readonly maxAgeSec?: number;
  readonly nowMs?: number;
}

/**
 * Verifies `initData` and returns the Telegram user inside it.
 *
 * `user.id` is the only identity this application recognises in the Mini App —
 * there are no cookies and no sessions of our own to steal.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  options: VerifyOptions = {},
): VerifiedInitData {
  const maxAgeSec = options.maxAgeSec ?? WRITE_MAX_AGE_SEC;
  const nowMs = options.nowMs ?? Date.now();

  const { hash, dataCheckString, params } = splitInitData(initData);

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InitDataError('bad hash');

  assertFreshAuthDate(params, maxAgeSec, nowMs);

  return {
    user: parseInitDataUser(params),
    startParam: initDataStartParam(params),
    authDate: Number(params.get('auth_date')),
    queryId: params.get('query_id'),
  };
}

/**
 * Builds valid `initData` for a given token. Only used by tests — there is no
 * production path that needs to forge a signature.
 */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

export { READ_MAX_AGE_SEC, WRITE_MAX_AGE_SEC };
