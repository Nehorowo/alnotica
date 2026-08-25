import { z } from 'zod';
import {
  APPOINTMENT_CREATORS,
  APPOINTMENT_STATUSES,
  BOT_MODES,
  BROADCAST_STATUSES,
  CLIENT_SOURCES,
  MEDIA_KINDS,
  PLANS,
  STAFF_ROLES,
  TENANT_KINDS,
} from '../types/index.js';
import {
  currencySchema,
  humanNameSchema,
  isoDateSchema,
  localTimeSchema,
  phoneSchema,
  priceMinorSchema,
  telegramIdSchema,
  timezoneSchema,
  uuidSchema,
} from './common.js';

export const planSchema = z.enum(PLANS);
export const tenantKindSchema = z.enum(TENANT_KINDS);
export const botModeSchema = z.enum(BOT_MODES);
export const staffRoleSchema = z.enum(STAFF_ROLES);
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export const appointmentCreatorSchema = z.enum(APPOINTMENT_CREATORS);
export const broadcastStatusSchema = z.enum(BROADCAST_STATUSES);
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export const clientSourceSchema = z.enum(CLIENT_SOURCES);

export const tenantSettingsSchema = z.object({
  autoConfirm: z.boolean().default(true),
  slotStepMin: z
    .number()
    .int()
    .refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'unsupported step'),
  minLeadTimeMin: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  bookingHorizonDays: z.number().int().min(1).max(180),
  cancelWindowHours: z.number().int().min(0).max(168),
  reminderOffsetsMin: z
    .array(
      z
        .number()
        .int()
        .min(5)
        .max(30 * 24 * 60),
    )
    .max(4),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const createTenantSchema = z.object({
  title: humanNameSchema,
  kind: tenantKindSchema,
  timezone: timezoneSchema,
  address: z.string().max(300).optional(),
  phone: phoneSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const createServiceSchema = z.object({
  name: humanNameSchema,
  description: z.string().max(1000).optional(),
  durationMin: z
    .number()
    .int()
    .min(5)
    .max(12 * 60),
  bufferAfterMin: z
    .number()
    .int()
    .min(0)
    .max(4 * 60)
    .default(0),
  priceMinor: priceMinorSchema.nullable().default(null),
  currency: currencySchema.default('RUB'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const workingHoursEntrySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startsLocal: localTimeSchema,
    endsLocal: localTimeSchema,
  })
  .refine((v) => v.startsLocal < v.endsLocal, 'the interval must end after it starts');
export type WorkingHoursEntry = z.infer<typeof workingHoursEntrySchema>;

export const timeOffSchema = z
  .object({
    startsAtMs: z.number().int(),
    endsAtMs: z.number().int(),
    reason: z.string().max(200).optional(),
  })
  .refine((v) => v.endsAtMs > v.startsAtMs, 'the interval must end after it starts');

export const manualClientSchema = z.object({
  name: humanNameSchema,
  phone: phoneSchema.optional(),
  notes: z.string().max(1000).optional(),
});

export const telegramClientSchema = z.object({
  telegramId: telegramIdSchema,
  name: humanNameSchema,
  username: z.string().max(64).optional(),
});

export const createAppointmentSchema = z.object({
  serviceId: uuidSchema,
  staffId: uuidSchema,
  startsAtMs: z.number().int().positive(),
  comment: z.string().max(500).optional(),
  createdBy: appointmentCreatorSchema.default('client'),
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const mediaRefSchema = z.object({
  fileId: z.string().min(1).max(200),
  fileUniqueId: z.string().min(1).max(64),
  kind: mediaKindSchema,
  caption: z.string().max(1024).optional(),
});

export const audienceFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('visited_within'), days: z.number().int().min(1).max(365) }),
  z.object({ kind: z.literal('not_visited_for'), days: z.number().int().min(1).max(730) }),
  z.object({ kind: z.literal('used_service'), serviceId: uuidSchema }),
]);

export const createBroadcastSchema = z.object({
  text: z.string().min(1).max(3000),
  mediaId: uuidSchema.nullable().default(null),
  audience: audienceFilterSchema,
});
export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;

export const statsRangeSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});
