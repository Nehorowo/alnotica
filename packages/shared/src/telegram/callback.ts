/**
 * Typed callback data.
 *
 * `callback_data` is limited to 64 *bytes* and arrives from the client, so it is
 * untrusted input: it is parsed with Zod, never with a bare `split(':')`. Anything
 * bigger than the budget belongs in the session, not in the button.
 *
 * Ownership is NOT established by this codec — a decoded appointment id still has
 * to be checked against the caller's tenant before anything happens.
 */
import { z } from 'zod';

export const MAX_CALLBACK_BYTES = 64;

const uuid = z.string().uuid();
const shortId = z.string().regex(/^[0-9a-z-]{1,36}$/);

export const callbackSchema = z.discriminatedUnion('a', [
  z.object({ a: z.literal('noop') }),
  z.object({ a: z.literal('consent'), v: z.enum(['accept', 'decline']) }),
  z.object({ a: z.literal('menu'), v: z.string().max(24) }),

  // client flow
  z.object({ a: z.literal('svc'), id: shortId }),
  z.object({ a: z.literal('staff'), id: z.union([shortId, z.literal('any')]) }),
  z.object({ a: z.literal('day'), d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ a: z.literal('slot'), t: z.number().int().nonnegative() }),
  z.object({ a: z.literal('more'), p: z.number().int().min(0).max(999) }),

  // appointment actions
  z.object({
    a: z.literal('appt'),
    o: z.enum(['show', 'cancel', 'resched', 'confirm', 'noshow', 'came']),
    id: uuid,
  }),
  z.object({ a: z.literal('appt_ok'), o: z.enum(['cancel', 'noshow', 'came']), id: uuid }),

  // staff cabinet
  z.object({ a: z.literal('day_nav'), d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ a: z.literal('page'), s: z.string().max(16), p: z.number().int().min(0).max(999) }),
  z.object({
    a: z.literal('svc_edit'),
    id: uuid,
    f: z.enum(['name', 'duration', 'price', 'buffer', 'toggle', 'delete']),
  }),
  z.object({ a: z.literal('wh'), w: z.number().int().min(0).max(6) }),
  z.object({ a: z.literal('cli'), id: uuid }),
  z.object({ a: z.literal('set'), k: z.string().max(24), v: z.string().max(24).optional() }),

  // broadcasts
  z.object({
    a: z.literal('bc'),
    o: z.enum(['new', 'send', 'cancel', 'audience', 'window']),
    id: uuid.optional(),
  }),
  z.object({ a: z.literal('bc_mod'), o: z.enum(['approve', 'reject']), id: uuid }),
  z.object({ a: z.literal('unsub'), t: uuid }),
]);

export type CallbackData = z.infer<typeof callbackSchema>;

/**
 * Compact wire format: `a|k=v|k=v`. Numbers keep their decimal form; the schema
 * coerces them back. Chosen over JSON because JSON's braces and quotes eat a
 * third of the 64-byte budget.
 */
export function encodeCallback(data: CallbackData): string {
  const { a, ...rest } = data;
  const parts: string[] = [a];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    parts.push(`${k}=${String(v)}`);
  }
  const encoded = parts.join('|');
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > MAX_CALLBACK_BYTES) {
    throw new RangeError(`callback data is ${bytes} bytes, over Telegram's ${MAX_CALLBACK_BYTES}`);
  }
  return encoded;
}

const NUMERIC = /^-?\d+$/;

/** Parses untrusted callback data. Returns null rather than throwing on garbage. */
export function decodeCallback(raw: string | undefined): CallbackData | null {
  if (!raw) return null;
  const [action, ...pairs] = raw.split('|');
  if (!action) return null;
  const obj: Record<string, unknown> = { a: action };
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    obj[key] = NUMERIC.test(value) ? Number(value) : value;
  }
  const parsed = callbackSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

/** Byte length of the encoded form, for tests that guard the 64-byte budget. */
export function callbackByteLength(data: CallbackData): number {
  const { a, ...rest } = data;
  const parts: string[] = [a];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return new TextEncoder().encode(parts.join('|')).length;
}
