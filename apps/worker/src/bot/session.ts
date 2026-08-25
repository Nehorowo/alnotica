/**
 * Conversation state.
 *
 * Only what does not fit in a button lives here: `callback_data` is capped at 64
 * bytes, so multi-step wizards keep their draft in the session and the buttons
 * carry nothing but a short action.
 */
import { z } from 'zod';

export const registrationDraftSchema = z.object({
  step: z.enum(['title', 'kind', 'timezone', 'service', 'schedule', 'done']),
  title: z.string().optional(),
  kind: z.string().optional(),
  timezone: z.string().optional(),
  serviceName: z.string().optional(),
  serviceDurationMin: z.number().int().optional(),
  servicePriceMinor: z.number().int().nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  startsLocal: z.string().optional(),
  endsLocal: z.string().optional(),
});

export const bookingDraftSchema = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid().optional(),
  staffId: z.string().optional(),
  date: z.string().optional(),
  page: z.number().int().min(0).default(0),
});

export const sessionSchema = z.object({
  /** Which message the menu currently occupies, so it is edited, not re-sent. */
  lastMenuMessageId: z.number().int().optional(),
  /** Tenant whose page the user arrived on. */
  tenantId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  registration: registrationDraftSchema.optional(),
  booking: bookingDraftSchema.optional(),
  /** Free-text step the next plain message answers. */
  awaiting: z
    .object({
      kind: z.enum([
        'reg_title',
        'reg_timezone',
        'reg_service',
        'reg_hours',
        'service_name',
        'service_duration',
        'service_price',
        'client_note',
        'client_search',
        'manual_client',
        'time_off',
        'broadcast_text',
      ]),
      context: z.string().optional(),
    })
    .optional(),
  staffTenantId: z.string().uuid().optional(),
});

export type SessionData = z.infer<typeof sessionSchema>;
export type RegistrationDraft = z.infer<typeof registrationDraftSchema>;
export type BookingDraft = z.infer<typeof bookingDraftSchema>;

export function emptySession(): SessionData {
  return {};
}

/**
 * A session row is JSON written by an earlier deployment, so it is parsed rather
 * than trusted. An unreadable session is reset instead of crashing the handler.
 */
export function parseSession(raw: unknown): SessionData {
  const parsed = sessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptySession();
}
