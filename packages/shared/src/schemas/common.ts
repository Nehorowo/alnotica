import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-MM-dd');
export const localTimeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:mm');

/**
 * Telegram ids can exceed 2^53. They arrive as a number or a string and always
 * become a bigint; a number that is not a safe integer is rejected rather than
 * silently rounded.
 */
export const telegramIdSchema = z
  .union([z.bigint(), z.string().regex(/^-?\d+$/), z.number()])
  .superRefine((v, ctx) => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'telegram id exceeds Number.MAX_SAFE_INTEGER; send it as a string',
      });
    }
  })
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)));

/** bigint rendered for the wire. */
export const bigintStringSchema = z
  .union([z.bigint(), z.string(), z.number()])
  .transform((v) => String(v));

export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown IANA time zone');

export const currencySchema = z.enum(['RUB', 'EUR', 'USD', 'KZT']);

/** Integer minor units. Never a float. */
export const priceMinorSchema = z.number().int().min(0).max(100_000_000);

export const epochMsSchema = z.number().int().nonnegative();

/** Trims and collapses whitespace before length checks, so "   " is empty. */
export const humanNameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(120));

export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[^\d+]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'expected a phone number'));

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(0).max(999).default(0),
  perPage: z.coerce.number().int().min(1).max(50).default(8),
});
