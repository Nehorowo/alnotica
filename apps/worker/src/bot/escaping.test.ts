/**
 * The escaping rule, enforced by a test rather than by discipline.
 *
 * Every message goes out with `parse_mode: 'HTML'`, and a master will eventually
 * name a service `Стрижка <люкс> & укладка`. One raw interpolation breaks the
 * parse for every message that mentions it, and the failure is a 400 from
 * Telegram that names neither the service nor the template.
 *
 * The brief asks for a Biome rule or a test on the templates. Biome cannot see
 * which template literals become message bodies, so this is the test: it reads
 * the bot's own sources and fails on an interpolation that is neither escaped
 * nor a value that cannot contain markup.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { esc, html, raw } from '@alnotica/shared';
import { describe, expect, it } from 'vitest';

const BOT_DIR = join(process.cwd(), 'apps/worker/src/bot');
const JOBS_DIR = join(process.cwd(), 'apps/worker/src/jobs');

function sources(dir: string): { name: string; body: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({
      name: `${dir.split('/').pop()}/${f}`,
      body: readFileSync(join(dir, f), 'utf8'),
    }));
}

/**
 * The fields that carry text a human typed: a service name, a client name, a
 * comment, an address. These are the only values that can smuggle markup into a
 * message, so these are the only ones the rule cares about. Numbers, ids,
 * formatted dates and our own constants cannot.
 */
const USER_CONTROLLED =
  /\.(name|title|text|comment|notes|phone|address|description|username|caption|reason|first_name|last_name)\b/;

/**
 * The same field names on things that are ours, not a user's: an error class
 * name, a bot's own username, a job kind. None of these can carry markup.
 */
const OURS = /^(error|err|e|job|row|me|botInfo|resolved\.row|ctx\.deps\.botRow|options\.botRow)\./;

/** Pulls the `${...}` holes out of every template literal in a source file. */
function unescapedInterpolations(body: string): { line: number; expression: string }[] {
  const found: { line: number; expression: string }[] = [];

  for (const [index, line] of body.split('\n').entries()) {
    const trimmed = line.trim();
    // Comments are full of examples of exactly what the rule forbids.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const pattern = /\$\{([^}]*)\}/g;
    let match = pattern.exec(line);
    while (match) {
      const expression = (match[1] ?? '').trim();
      const before = line.slice(0, match.index);
      // A hole inside an `html` tagged template is escaped by the tag itself.
      const tagged = /html`[^`]*$/.test(before);

      if (
        !tagged &&
        USER_CONTROLLED.test(expression) &&
        !OURS.test(expression) &&
        !expression.includes('esc(')
      ) {
        found.push({ line: index + 1, expression });
      }
      match = pattern.exec(line);
    }
  }
  return found;
}

describe('the html tagged template', () => {
  it('escapes every hole and nothing else', () => {
    const name = 'Стрижка <люкс> & укладка';
    expect(html`<b>${name}</b>`.value).toBe('<b>Стрижка &lt;люкс&gt; &amp; укладка</b>');
  });

  it('lets an already-safe fragment through unchanged', () => {
    const inner = html`<i>${'a & b'}</i>`;
    expect(html`<b>${inner}</b>`.value).toBe('<b><i>a &amp; b</i></b>');
    expect(esc(raw('<b>ok</b>'))).toBe('<b>ok</b>');
  });

  it('would break the message if a name were interpolated raw', () => {
    const name = '<b>';
    // This is what the rule below exists to prevent: unbalanced markup that
    // Telegram rejects with a 400 naming neither the service nor the template.
    expect(`<b>${name}</b>`).toBe('<b><b></b>');
    expect(html`<b>${name}</b>`.value).toBe('<b>&lt;b&gt;</b>');
  });
});

describe('the rule itself', () => {
  it('catches a raw user string', () => {
    const bad = 'const text = `<b>${service.name}</b>`;';
    expect(unescapedInterpolations(bad)).toHaveLength(1);
  });

  it('accepts the two safe forms', () => {
    expect(unescapedInterpolations('const t = `<b>${esc(service.name)}</b>`;')).toEqual([]);
    expect(unescapedInterpolations('const t = html`<b>${service.name}</b>`;')).toEqual([]);
  });

  it('ignores values that cannot contain markup', () => {
    expect(unescapedInterpolations('const t = `${count} записей за ${days} дней`;')).toEqual([]);
    // `name` on one of our own objects is a class name, not something a user typed.
    expect(unescapedInterpolations('const m = `${error.name}: ${error.message}`;')).toEqual([]);
  });

  it('ignores an example inside a comment', () => {
    expect(unescapedInterpolations('  // never write `<b>${service.name}</b>`')).toEqual([]);
  });
});

describe('no source interpolates a user string into a message', () => {
  const files = [...sources(BOT_DIR), ...sources(JOBS_DIR)];

  it('finds the bot sources', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const file of files) {
    it(`${file.name}`, () => {
      expect(
        unescapedInterpolations(file.body).map((o) => `${file.name}:${o.line} \${${o.expression}}`),
        'interpolate through esc() or the html`` tag',
      ).toEqual([]);
    });
  }
});
