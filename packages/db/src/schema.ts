/**
 * Drizzle schema. This is the source of truth for *queries*; the DDL itself
 * lives in `migrations/` as plain SQL, because two constraints the product
 * depends on (`EXCLUDE USING gist ... WHERE`) cannot be expressed here.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `bytea` for the AES-256-GCM envelope around a dedicated bot's token. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/* ---------------------------------- bots ---------------------------------- */

export const bot = pgTable(
  'bot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'shared' — everyone rides our bot; 'dedicated' — the tenant's own. */
    mode: text('mode').notNull().$type<'shared' | 'dedicated'>(),
    username: text('username').notNull(),
    /** Never logged, never returned by any API. */
    tokenEncrypted: bytea('token_encrypted'),
    /** 32 random characters; the webhook path. Not derived from the token. */
    botHash: text('bot_hash').notNull().unique(),
    webhookSetAt: tz('webhook_set_at'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bot_username_idx').on(t.username)],
);

/* --------------------------------- tenants -------------------------------- */

export const tenant = pgTable(
  'tenant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    /** IANA zone. All scheduling arithmetic happens in it. */
    timezone: text('timezone').notNull().default('Europe/Moscow'),
    address: text('address'),
    phone: text('phone'),
    plan: text('plan').notNull().default('free').$type<'free' | 'pro' | 'team'>(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bot.id),
    autoConfirm: boolean('auto_confirm').notNull().default(true),
    slotStepMin: integer('slot_step_min').notNull().default(30),
    minLeadTimeMin: integer('min_lead_time_min').notNull().default(120),
    bookingHorizonDays: integer('booking_horizon_days').notNull().default(30),
    cancelWindowHours: integer('cancel_window_hours').notNull().default(4),
    reminderOffsetsMin: integer('reminder_offsets_min')
      .array()
      .notNull()
      .default(sql`'{1440,120}'::int[]`),
    createdAt: tz('created_at').notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('tenant_bot_idx').on(t.botId)],
);

/* ---------------------------------- staff --------------------------------- */

export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    /** Beyond 2^53 in the wild, hence bigint on both sides of the wire. */
    telegramId: bigint('telegram_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    role: text('role').notNull().default('staff').$type<'owner' | 'staff'>(),
    isActive: boolean('is_active').notNull().default(true),
    mediaId: uuid('media_id'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_tenant_tg_idx').on(t.tenantId, t.telegramId),
    index('staff_tg_idx').on(t.telegramId),
  ],
);

/* -------------------------------- services -------------------------------- */

export const service = pgTable(
  'service',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    durationMin: integer('duration_min').notNull(),
    bufferAfterMin: integer('buffer_after_min').notNull().default(0),
    /** Integer minor units. Never a float. */
    priceMinor: integer('price_minor'),
    currency: text('currency').notNull().default('RUB'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('service_tenant_idx').on(t.tenantId, t.sortOrder)],
);

export const staffService = pgTable(
  'staff_service',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('staff_service_pk').on(t.staffId, t.serviceId),
    index('staff_service_service_idx').on(t.serviceId),
  ],
);

/* -------------------------------- schedule -------------------------------- */

export const workingHours = pgTable(
  'working_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: integer('weekday').notNull(),
    /** Local wall clock in the tenant's zone, never UTC. */
    startsLocal: time('starts_local').notNull(),
    endsLocal: time('ends_local').notNull(),
  },
  (t) => [index('working_hours_staff_idx').on(t.staffId, t.weekday)],
);

export const timeOff = pgTable(
  'time_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    startsAt: tz('starts_at').notNull(),
    endsAt: tz('ends_at').notNull(),
    reason: text('reason'),
  },
  (t) => [index('time_off_staff_idx').on(t.staffId, t.startsAt)],
);

/* --------------------------------- clients -------------------------------- */

export const client = pgTable(
  'client',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    /** Null for a client the master entered by hand — they get no reminders. */
    telegramId: bigint('telegram_id', { mode: 'bigint' }),
    name: text('name').notNull(),
    phone: text('phone'),
    username: text('username'),
    notes: text('notes'),
    /** Set when Telegram tells us the user blocked the bot (403). */
    isBlocked: boolean('is_blocked').notNull().default(false),
    marketingOptOut: boolean('marketing_opt_out').notNull().default(false),
    /** Null until the client accepts the personal-data notice. */
    consentAt: tz('consent_at'),
    source: text('source').notNull().default('deeplink'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('client_tenant_idx').on(t.tenantId, t.name)],
);

/* ------------------------------ appointments ------------------------------ */

export const appointment = pgTable(
  'appointment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => client.id),
    /** Short public handle, used in `r_<ref>` deep links. */
    ref: text('ref').notNull().unique(),
    startsAt: tz('starts_at').notNull(),
    /** Materialized: startsAt + durationMin + bufferAfterMin. */
    endsAt: tz('ends_at').notNull(),
    status: text('status').notNull().default('confirmed'),
    priceMinor: integer('price_minor'),
    comment: text('comment'),
    /** Set when the client taps "I'll be there" — an extra signal against no-show. */
    confirmedByClientAt: tz('confirmed_by_client_at'),
    cancelledAt: tz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    rescheduledFromId: uuid('rescheduled_from_id'),
    createdBy: text('created_by').notNull().default('client').$type<'client' | 'staff'>(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('appointment_tenant_starts_idx').on(t.tenantId, t.startsAt),
    index('appointment_client_starts_idx').on(t.clientId, t.startsAt),
    index('appointment_staff_starts_idx').on(t.staffId, t.startsAt),
  ],
);

/* ---------------------------------- media --------------------------------- */

/**
 * We store references, never bytes. A `file_id` is only valid for the bot that
 * received the file, so moving a tenant to a dedicated bot invalidates them all
 * and sets `needsReupload`; `file_unique_id` survives the move but cannot be
 * downloaded, so it is only good for deduplication.
 */
export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bot.id),
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    kind: text('kind').notNull(),
    caption: text('caption'),
    needsReupload: boolean('needs_reupload').notNull().default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('media_tenant_idx').on(t.tenantId)],
);

/* ------------------------------- broadcasts ------------------------------- */

export const broadcast = pgTable(
  'broadcast',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    mediaId: uuid('media_id').references(() => media.id),
    audience: jsonb('audience').notNull(),
    status: text('status').notNull().default('draft'),
    moderatedBy: bigint('moderated_by', { mode: 'bigint' }),
    total: integer('total').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
  },
  (t) => [index('broadcast_tenant_idx').on(t.tenantId, t.createdAt)],
);

/* -------------------------------- telegram -------------------------------- */

export const tgUpdate = pgTable(
  'tg_update',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bot.id),
    updateId: bigint('update_id', { mode: 'number' }).notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
    processedAt: tz('processed_at'),
    error: text('error'),
  },
  (t) => [uniqueIndex('tg_update_bot_update_idx').on(t.botId, t.updateId)],
);

/** grammY session storage. Restarting must not drop a half-finished dialogue. */
export const session = pgTable('session', {
  key: text('key').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/* ---------------------------------- queue --------------------------------- */

export const job = pgTable(
  'job',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /** Lower is more urgent: transactional 10, reminders 20, broadcasts 900. */
    priority: integer('priority').notNull().default(100),
    runAt: tz('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: tz('locked_at'),
    lockedBy: text('locked_by'),
    finishedAt: tz('finished_at'),
    lastError: text('last_error'),
    /** Unique, so scheduling the same reminder twice is a no-op. */
    dedupeKey: text('dedupe_key').unique(),
    /** 'appt:<uuid>' — lets a cancellation extinguish every related job at once. */
    cancelKey: text('cancel_key'),
  },
  (t) => [index('job_ready_idx').on(t.priority, t.runAt), index('job_cancel_idx').on(t.cancelKey)],
);

/* ------------------------------ idempotency ------------------------------- */

/** Replay protection for `POST /api/miniapp/book`. */
export const idempotency = pgTable('idempotency', {
  key: text('key').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  appointmentId: uuid('appointment_id'),
  response: jsonb('response').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** Bookkeeping for the "reminders delivered / confirmed" line in the stats. */
export const reminderLog = pgTable(
  'reminder_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointment.id, { onDelete: 'cascade' }),
    offsetMin: integer('offset_min').notNull(),
    sentAt: tz('sent_at').notNull().defaultNow(),
    delivered: boolean('delivered').notNull().default(true),
    error: text('error'),
  },
  (t) => [index('reminder_log_tenant_idx').on(t.tenantId, t.sentAt)],
);

export const schema = {
  bot,
  tenant,
  staff,
  service,
  staffService,
  workingHours,
  timeOff,
  client,
  appointment,
  media,
  broadcast,
  tgUpdate,
  session,
  job,
  idempotency,
  reminderLog,
};

export type BotRow = typeof bot.$inferSelect;
export type TenantRow = typeof tenant.$inferSelect;
export type StaffRow = typeof staff.$inferSelect;
export type ServiceRow = typeof service.$inferSelect;
export type WorkingHoursRow = typeof workingHours.$inferSelect;
export type TimeOffRow = typeof timeOff.$inferSelect;
export type ClientRow = typeof client.$inferSelect;
export type AppointmentRow = typeof appointment.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type BroadcastRow = typeof broadcast.$inferSelect;
export type JobRow = typeof job.$inferSelect;
export type TgUpdateRow = typeof tgUpdate.$inferSelect;
