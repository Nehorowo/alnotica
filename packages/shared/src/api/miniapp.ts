/**
 * The Mini App <-> API contract. Both sides import these schemas: the server
 * validates what it receives and the client validates what it gets back, so a
 * deployment skew shows up as a clear error instead of an undefined field.
 */
import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '../schemas/common.js';

/* -------------------------------- responses ------------------------------- */

export const slotDtoSchema = z.object({
  startsAtMs: z.number().int(),
  endsAtMs: z.number().int(),
  serviceEndsAtMs: z.number().int(),
  localTime: z.string(),
  localDate: z.string(),
  ambiguous: z.boolean(),
});
export type SlotDto = z.infer<typeof slotDtoSchema>;

export const dayAvailabilitySchema = z.object({
  date: isoDateSchema,
  slots: z.array(slotDtoSchema),
});

export const serviceDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  durationMin: z.number().int(),
  bufferAfterMin: z.number().int(),
  priceMinor: z.number().int().nullable(),
  currency: z.string(),
});
export type ServiceDto = z.infer<typeof serviceDtoSchema>;

export const staffDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
});

export const availabilityResponseSchema = z.object({
  tenant: z.object({
    title: z.string(),
    timezone: z.string(),
    address: z.string().nullable(),
    bookingHorizonDays: z.number().int(),
  }),
  service: serviceDtoSchema,
  staff: staffDtoSchema,
  days: z.array(dayAvailabilitySchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

export const appointmentDtoSchema = z.object({
  id: uuidSchema,
  ref: z.string(),
  status: z.string(),
  startsAtMs: z.number().int(),
  endsAtMs: z.number().int(),
  serviceName: z.string(),
  staffName: z.string(),
  clientName: z.string(),
  priceMinor: z.number().int().nullable(),
  currency: z.string(),
  localDate: z.string(),
  localTime: z.string(),
});
export type AppointmentDto = z.infer<typeof appointmentDtoSchema>;

export const bookResponseSchema = z.object({
  appointment: appointmentDtoSchema,
  /** True when this exact Idempotency-Key had already produced this appointment. */
  replayed: z.boolean(),
});
export type BookResponse = z.infer<typeof bookResponseSchema>;

export const scheduleResponseSchema = z.object({
  tenant: z.object({ title: z.string(), timezone: z.string() }),
  from: isoDateSchema,
  to: isoDateSchema,
  staff: z.array(staffDtoSchema),
  services: z.array(serviceDtoSchema),
  appointments: z.array(
    appointmentDtoSchema.extend({ staffId: uuidSchema, comment: z.string().nullable() }),
  ),
  timeOff: z.array(
    z.object({
      id: uuidSchema,
      staffId: uuidSchema,
      startsAtMs: z.number().int(),
      endsAtMs: z.number().int(),
      reason: z.string().nullable(),
    }),
  ),
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present on `slot_taken`: what is still free nearby. */
    alternatives: z.array(slotDtoSchema).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/* --------------------------------- requests ------------------------------- */

export const availabilityQuerySchema = z.object({
  serviceId: uuidSchema,
  staffId: z.union([uuidSchema, z.literal('any')]).default('any'),
  from: isoDateSchema,
  to: isoDateSchema,
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const bookRequestSchema = z.object({
  serviceId: uuidSchema,
  staffId: z.union([uuidSchema, z.literal('any')]).default('any'),
  startsAtMs: z.number().int().positive(),
  comment: z.string().max(500).optional(),
});
export type BookRequest = z.infer<typeof bookRequestSchema>;

export const scheduleQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});

export const staffBookRequestSchema = z.object({
  serviceId: uuidSchema,
  staffId: uuidSchema,
  startsAtMs: z.number().int().positive(),
  clientId: uuidSchema.optional(),
  clientName: z.string().min(1).max(120).optional(),
  clientPhone: z.string().max(32).optional(),
  comment: z.string().max(500).optional(),
});
export type StaffBookRequest = z.infer<typeof staffBookRequestSchema>;

export const INIT_DATA_HEADER = 'x-telegram-init-data';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
