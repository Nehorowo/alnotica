import { describe, expect, it } from 'vitest';
import { InitDataError } from '../errors.js';
import {
  MAX_CALLBACK_BYTES,
  callbackByteLength,
  decodeCallback,
  encodeCallback,
} from './callback.js';
import {
  MAX_PAYLOAD_LENGTH,
  encodeStartPayload,
  isValidPayload,
  parseStartPayload,
  startLink,
} from './deeplink.js';
import {
  assertFreshAuthDate,
  buildDataCheckString,
  initDataStartParam,
  parseInitDataUser,
  splitInitData,
} from './init-data.js';

describe('deep-link payloads', () => {
  it('round-trips each payload kind', () => {
    const cases = [
      { kind: 'master', slug: 'k3n7p2qa' },
      { kind: 'service', slug: 'k3n7p2qa', serviceIdx: 3 },
      { kind: 'ref', ref: 'abc123' },
    ] as const;
    for (const payload of cases) {
      expect(parseStartPayload(encodeStartPayload(payload))).toEqual(payload);
    }
  });

  it('produces exactly the documented shapes', () => {
    expect(encodeStartPayload({ kind: 'master', slug: 'k3n7p2qa' })).toBe('m_k3n7p2qa');
    expect(encodeStartPayload({ kind: 'service', slug: 'k3n7p2qa', serviceIdx: 0 })).toBe(
      's_k3n7p2qa_0',
    );
    expect(encodeStartPayload({ kind: 'ref', ref: 'q9x2' })).toBe('r_q9x2');
  });

  it('stays inside Telegram alphabet and length limits', () => {
    expect(isValidPayload('m_k3n7p2qa')).toBe(true);
    expect(isValidPayload('m_к3н7п2')).toBe(false); // Cyrillic
    expect(isValidPayload('m:k3n7p2qa')).toBe(false);
    expect(isValidPayload('m.k3n7p2qa')).toBe(false);
    expect(isValidPayload('')).toBe(false);
    expect(isValidPayload(`m_${'a'.repeat(MAX_PAYLOAD_LENGTH)}`)).toBe(false);
  });

  it('refuses to encode a payload Telegram would reject', () => {
    expect(() => encodeStartPayload({ kind: 'ref', ref: 'a'.repeat(70) })).toThrow(RangeError);
    expect(() => encodeStartPayload({ kind: 'master', slug: 'ку' })).toThrow(RangeError);
  });

  it('returns null for anything unrecognised', () => {
    expect(parseStartPayload(undefined)).toBeNull();
    expect(parseStartPayload('')).toBeNull();
    expect(parseStartPayload('hello')).toBeNull();
    expect(parseStartPayload('x_abc')).toBeNull();
    expect(parseStartPayload('m_')).toBeNull();
    expect(parseStartPayload('s_abc')).toBeNull(); // no service index
    expect(parseStartPayload('s_abc_x')).toBeNull(); // index is not a number
  });

  it('keeps the slug intact when it contains underscores', () => {
    expect(parseStartPayload('s_a_b_2')).toEqual({ kind: 'service', slug: 'a_b', serviceIdx: 2 });
  });

  it('builds a t.me link', () => {
    expect(startLink('@AlnoticaBot', { kind: 'master', slug: 'k3n7p2qa' })).toBe(
      'https://t.me/AlnoticaBot?start=m_k3n7p2qa',
    );
    expect(() => startLink('no', { kind: 'master', slug: 'a' })).toThrow();
  });
});

describe('callback data codec', () => {
  it('round-trips every shape it accepts', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const cases = [
      { a: 'noop' },
      { a: 'consent', v: 'accept' },
      { a: 'slot', t: 1_717_000_000_000 },
      { a: 'appt', o: 'cancel', id },
      { a: 'page', s: 'clients', p: 3 },
      { a: 'svc_edit', id, f: 'duration' },
      { a: 'bc', o: 'new' },
    ] as const;
    for (const data of cases) {
      expect(decodeCallback(encodeCallback(data))).toEqual(data);
    }
  });

  it('keeps every encodable payload inside the 64-byte budget', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(callbackByteLength({ a: 'appt', o: 'resched', id })).toBeLessThanOrEqual(
      MAX_CALLBACK_BYTES,
    );
    expect(callbackByteLength({ a: 'svc_edit', id, f: 'duration' })).toBeLessThanOrEqual(
      MAX_CALLBACK_BYTES,
    );
    expect(callbackByteLength({ a: 'appt_ok', o: 'noshow', id })).toBeLessThanOrEqual(
      MAX_CALLBACK_BYTES,
    );
  });

  it('refuses to encode something too large for a button', () => {
    // The budget is counted in bytes, not characters: 'menu|v=' is 7 bytes and
    // each Cyrillic letter costs two, so 28 letters fit and 29 do not.
    expect(() => encodeCallback({ a: 'menu', v: 'я'.repeat(28) })).not.toThrow();
    expect(() => encodeCallback({ a: 'menu', v: 'я'.repeat(29) })).toThrow(RangeError);
    expect(() => encodeCallback({ a: 'menu', v: 'x'.repeat(58) })).toThrow(RangeError);
  });

  it('treats malformed callback data as absent rather than crashing', () => {
    expect(decodeCallback(undefined)).toBeNull();
    expect(decodeCallback('')).toBeNull();
    expect(decodeCallback('appt|o=cancel|id=not-a-uuid')).toBeNull();
    expect(decodeCallback('appt|o=explode|id=11111111-2222-3333-4444-555555555555')).toBeNull();
    expect(decodeCallback('unknown_action')).toBeNull();
    expect(decodeCallback('appt|nokey')).toBeNull();
    expect(decodeCallback('appt|=v')).toBeNull();
  });

  it('does not confuse a numeric-looking string field with a number', () => {
    const encoded = encodeCallback({ a: 'day', d: '2024-06-05' });
    expect(decodeCallback(encoded)).toEqual({ a: 'day', d: '2024-06-05' });
  });

  it('omits optional fields that are undefined', () => {
    expect(encodeCallback({ a: 'bc', o: 'new' })).toBe('bc|o=new');
    expect(callbackByteLength({ a: 'bc', o: 'new' })).toBe(8);
  });
});

describe('initData parsing', () => {
  const params = (obj: Record<string, string>) => new URLSearchParams(obj);

  it('sorts the data-check string by code point, not by locale', () => {
    // In several locales `localeCompare` orders these differently from code points.
    const p = params({ b: '1', a: '2', A: '3', _z: '4' });
    expect(buildDataCheckString(p)).toBe('A=3\n_z=4\na=2\nb=1');
  });

  it('excludes hash and signature from the signed payload', () => {
    const raw = `auth_date=1717000000&hash=${'a'.repeat(64)}&signature=zzz&user=%7B%7D`;
    const split = splitInitData(raw);
    expect(split.hash).toBe('a'.repeat(64));
    expect(split.dataCheckString).toBe('auth_date=1717000000\nuser={}');
    expect(split.params.has('signature')).toBe(false);
  });

  it('rejects initData with no hash or a malformed one', () => {
    expect(() => splitInitData('auth_date=1')).toThrow(InitDataError);
    expect(() => splitInitData('hash=short&auth_date=1')).toThrow(InitDataError);
  });

  it('accepts a fresh auth_date and rejects an old one', () => {
    const nowMs = 1_717_000_000_000;
    const fresh = params({ auth_date: String(nowMs / 1000 - 60) });
    expect(() => assertFreshAuthDate(fresh, 900, nowMs)).not.toThrow();

    const stale = params({ auth_date: String(nowMs / 1000 - 901) });
    expect(() => assertFreshAuthDate(stale, 900, nowMs)).toThrow(InitDataError);
    // The same timestamp is still fine for a read-only call.
    expect(() => assertFreshAuthDate(stale, 86_400, nowMs)).not.toThrow();
  });

  it('rejects a missing, unparseable or far-future auth_date', () => {
    const nowMs = 1_717_000_000_000;
    expect(() => assertFreshAuthDate(params({}), 900, nowMs)).toThrow(InitDataError);
    expect(() => assertFreshAuthDate(params({ auth_date: 'soon' }), 900, nowMs)).toThrow(
      InitDataError,
    );
    expect(() => assertFreshAuthDate(params({ auth_date: '0' }), 900, nowMs)).toThrow(
      InitDataError,
    );
    const future = params({ auth_date: String(nowMs / 1000 + 3600) });
    expect(() => assertFreshAuthDate(future, 900, nowMs)).toThrow(InitDataError);
  });

  it('tolerates small clock skew in the client', () => {
    const nowMs = 1_717_000_000_000;
    const slightlyAhead = params({ auth_date: String(nowMs / 1000 + 120) });
    expect(() => assertFreshAuthDate(slightlyAhead, 900, nowMs)).not.toThrow();
  });

  it('parses the user object, keeping a large id exact', () => {
    const user = parseInitDataUser(
      params({
        user: JSON.stringify({ id: '9007199254740993', first_name: 'Аня', username: 'anya' }),
      }),
    );
    expect(user.id).toBe(9_007_199_254_740_993n);
    expect(user.first_name).toBe('Аня');
    expect(user.username).toBe('anya');
  });

  it('rejects a missing or broken user field', () => {
    expect(() => parseInitDataUser(params({}))).toThrow(InitDataError);
    expect(() => parseInitDataUser(params({ user: 'not json' }))).toThrow(InitDataError);
    expect(() => parseInitDataUser(params({ user: '{"first_name":"x"}' }))).toThrow(InitDataError);
  });

  it('exposes the startapp parameter', () => {
    expect(initDataStartParam(params({ start_param: 'm_k3n7p2qa' }))).toBe('m_k3n7p2qa');
    expect(initDataStartParam(params({}))).toBeNull();
  });
});
