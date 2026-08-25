import { describe, expect, it } from 'vitest';
import { assertDefined, assertNever } from './assert.js';
import { bigintReplacer, jsonStringify, parseTelegramId, toJsonSafe } from './bigint.js';
import { esc, html, joinLines, raw } from './html.js';
import { formatMoney, sumMinor } from './money.js';
import { SLUG_LENGTH, generateSlug, isValidSlug, normalizeSlug } from './slug.js';

describe('assert helpers', () => {
  it('throws loudly when a union grows a member', () => {
    // The cast mirrors what happens at runtime when a new status arrives from the DB.
    expect(() => assertNever('surprise' as never, 'status')).toThrow(/Unhandled status/);
  });

  it('turns a missing value into a named error', () => {
    expect(assertDefined(0, 'zero')).toBe(0);
    expect(() => assertDefined(null, 'tenant')).toThrow(/Expected tenant/);
    expect(() => assertDefined(undefined, 'tenant')).toThrow(/Expected tenant/);
  });
});

describe('bigint serialization', () => {
  // Well past 2^53 — a real Telegram id can look like this.
  const huge = 9_007_199_254_740_993n;

  it('is exactly the value plain JSON.stringify refuses', () => {
    expect(() => JSON.stringify({ id: huge })).toThrow(TypeError);
    expect(jsonStringify({ id: huge })).toBe('{"id":"9007199254740993"}');
  });

  it('survives a round trip without losing the last digit', () => {
    const back = BigInt(JSON.parse(jsonStringify({ id: huge })).id);
    expect(back).toBe(huge);
    // Converting to Number is exactly the loss we are avoiding: the literal
    // 9_007_199_254_740_993 is not even representable and rounds down.
    expect(Number(huge)).toBe(9_007_199_254_740_992);
  });

  it('converts bigints anywhere in the tree', () => {
    const input = { a: huge, b: [1n, { c: 2n }], d: 'x', e: null, f: new Date(0) };
    expect(toJsonSafe(input)).toEqual({
      a: '9007199254740993',
      b: ['1', { c: '2' }],
      d: 'x',
      e: null,
      f: new Date(0),
    });
  });

  it('exposes the replacer on its own', () => {
    expect(bigintReplacer('k', 1n)).toBe('1');
    expect(bigintReplacer('k', 'v')).toBe('v');
  });

  it('parses ids from every shape the wire uses', () => {
    expect(parseTelegramId(huge)).toBe(huge);
    expect(parseTelegramId('9007199254740993')).toBe(huge);
    expect(parseTelegramId(-1_001_234_567_890)).toBe(-1_001_234_567_890n);
  });

  it('refuses a number that has already lost precision', () => {
    // biome-ignore lint/correctness/noPrecisionLoss: an already-rounded literal is the input under test
    expect(() => parseTelegramId(9_007_199_254_740_993)).toThrow(TypeError);
    expect(() => parseTelegramId('12a')).toThrow(TypeError);
    expect(() => parseTelegramId({})).toThrow(TypeError);
  });
});

describe('HTML escaping', () => {
  it('escapes the characters that break Telegram markup', () => {
    expect(esc('Стрижка <люкс> & укладка')).toBe('Стрижка &lt;люкс&gt; &amp; укладка');
    expect(esc('a "b"')).toBe('a &quot;b&quot;');
  });

  it('renders empty for absent values', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(0)).toBe('0');
  });

  it('escapes every hole of a template but not the markup around it', () => {
    const name = '<script>alert(1)</script>';
    expect(html`<b>${name}</b>`.toString()).toBe('<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>');
  });

  it('does not double-escape an already-safe fragment', () => {
    const inner = html`<i>${'a & b'}</i>`;
    expect(html`<b>${inner}</b>`.toString()).toBe('<b><i>a &amp; b</i></b>');
    expect(esc(raw('<b>ok</b>'))).toBe('<b>ok</b>');
  });

  it('joins lines and drops empty ones', () => {
    expect(joinLines([html`<b>a</b>`, null, '', 'b & c', undefined])).toBe('<b>a</b>\nb &amp; c');
  });
});

describe('money', () => {
  it('formats minor units with a thin thousands separator', () => {
    expect(formatMoney(300_000)).toBe('3\u00a0000\u00a0₽');
    expect(formatMoney(150_050)).toBe('1\u00a0500,50\u00a0₽');
    expect(formatMoney(0)).toBe('0\u00a0₽');
    expect(formatMoney(-50_000)).toBe('-500\u00a0₽');
    expect(formatMoney(1_000, 'EUR')).toBe('10\u00a0€');
  });

  it('sums nullable prices', () => {
    expect(sumMinor([100, null, 200, undefined])).toBe(300);
    expect(sumMinor([])).toBe(0);
  });
});

describe('slugs', () => {
  it('produces the configured length from the reduced alphabet', () => {
    const slug = generateSlug();
    expect(slug).toHaveLength(SLUG_LENGTH);
    expect(isValidSlug(slug)).toBe(true);
    expect(slug).not.toMatch(/[ilou]/);
  });

  it('maps every byte value onto the alphabet without bias', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const slug = generateSlug(256, () => bytes);
    const counts = new Map<string, number>();
    for (const ch of slug) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((c) => c === 8)).toBe(true);
  });

  it('rejects slugs containing ambiguous letters', () => {
    expect(isValidSlug('k3n7p2qa')).toBe(true);
    expect(isValidSlug('k3n7p2qi')).toBe(false);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('K3N7P2QA')).toBe(false);
  });

  it('folds the look-alikes a human might type', () => {
    expect(normalizeSlug(' K3N7P2QA ')).toBe('k3n7p2qa');
    expect(normalizeSlug('OIL')).toBe('011');
    expect(normalizeSlug('U')).toBe('v');
  });
});
