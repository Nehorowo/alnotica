/**
 * Telegram messages are sent with parse_mode: 'HTML'. Any user-controlled string
 * (service names, client names, comments) must pass through `esc` first, or a
 * service called "Стрижка <люкс> & укладка" breaks the whole message.
 */

/** Marks an already-safe markup fragment so it is not escaped again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Wraps trusted markup we produced ourselves. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/** Escapes the characters Telegram's HTML parser treats as markup. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.value;
  return String(value).replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
}

/**
 * Tagged template that escapes every interpolated value. The static parts of the
 * template are trusted (they are our own markup), the holes never are.
 *
 *   html`<b>${service.name}</b>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += esc(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Joins fragments with a separator, escaping anything that is not already safe. */
export function joinLines(parts: readonly (SafeHtml | string | null | undefined)[]): string {
  return parts
    .filter((p): p is SafeHtml | string => p !== null && p !== undefined && String(p) !== '')
    .map((p) => esc(p))
    .join('\n');
}
