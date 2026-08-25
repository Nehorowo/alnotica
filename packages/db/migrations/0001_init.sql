-- Initial schema.
--
-- `btree_gist` is what lets an EXCLUDE constraint mix an equality on a uuid with
-- an overlap test on a time range; without it the double-booking guard below
-- cannot be created at all.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE bot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode             text NOT NULL CHECK (mode IN ('shared', 'dedicated')),
  username         text NOT NULL,
  token_encrypted  bytea,
  bot_hash         text NOT NULL UNIQUE,
  webhook_set_at   timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bot_username_idx ON bot (username);

CREATE TABLE tenant (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  title                text NOT NULL,
  kind                 text NOT NULL,
  timezone             text NOT NULL DEFAULT 'Europe/Moscow',
  address              text,
  phone                text,
  plan                 text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  bot_id               uuid NOT NULL REFERENCES bot (id),
  auto_confirm         boolean NOT NULL DEFAULT true,
  slot_step_min        int NOT NULL DEFAULT 30 CHECK (slot_step_min > 0),
  min_lead_time_min    int NOT NULL DEFAULT 120 CHECK (min_lead_time_min >= 0),
  booking_horizon_days int NOT NULL DEFAULT 30 CHECK (booking_horizon_days > 0),
  cancel_window_hours  int NOT NULL DEFAULT 4 CHECK (cancel_window_hours >= 0),
  reminder_offsets_min int[] NOT NULL DEFAULT '{1440,120}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  is_active            boolean NOT NULL DEFAULT true
);
CREATE INDEX tenant_bot_idx ON tenant (bot_id);

CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL REFERENCES bot (id),
  file_id         text NOT NULL,
  file_unique_id  text NOT NULL,
  kind            text NOT NULL,
  caption         text,
  needs_reupload  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_tenant_idx ON media (tenant_id);

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Telegram ids exceed 2^53; bigint here, bigint or string in TypeScript.
  telegram_id bigint NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  is_active   boolean NOT NULL DEFAULT true,
  media_id    uuid REFERENCES media (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_tenant_tg_idx ON staff (tenant_id, telegram_id);
CREATE INDEX staff_tg_idx ON staff (telegram_id);

CREATE TABLE service (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  duration_min      int NOT NULL CHECK (duration_min > 0),
  buffer_after_min  int NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  -- Money is an integer count of minor units. Never a float.
  price_minor       int CHECK (price_minor IS NULL OR price_minor >= 0),
  currency          text NOT NULL DEFAULT 'RUB',
  sort_order        int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_tenant_idx ON service (tenant_id, sort_order);

CREATE TABLE staff_service (
  staff_id   uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);
CREATE INDEX staff_service_service_idx ON staff_service (service_id);

CREATE TABLE working_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  weekday      int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- Local wall clock in the tenant's zone. Converting to UTC here would be wrong:
  -- the same 09:00 is a different instant on either side of a DST transition.
  starts_local time NOT NULL,
  ends_local   time NOT NULL,
  CHECK (ends_local > starts_local)
);
CREATE INDEX working_hours_staff_idx ON working_hours (staff_id, weekday);

CREATE TABLE time_off (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id  uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  reason    text,
  CHECK (ends_at > starts_at)
);
CREATE INDEX time_off_staff_idx ON time_off (staff_id, starts_at);

-- One master cannot be on holiday twice at once.
ALTER TABLE time_off ADD CONSTRAINT time_off_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );

CREATE TABLE client (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Null for a client the master typed in by hand: they never pressed /start,
  -- so the bot is not allowed to message them and they get no reminders.
  telegram_id       bigint,
  name              text NOT NULL,
  phone             text,
  username          text,
  notes             text,
  is_blocked        boolean NOT NULL DEFAULT false,
  marketing_opt_out boolean NOT NULL DEFAULT false,
  consent_at        timestamptz,
  source            text NOT NULL DEFAULT 'deeplink',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_tenant_tg_idx ON client (tenant_id, telegram_id)
  WHERE telegram_id IS NOT NULL;
CREATE INDEX client_tenant_idx ON client (tenant_id, name);
-- Broadcast audiences filter on exactly this predicate.
CREATE INDEX client_reachable_idx ON client (tenant_id)
  WHERE telegram_id IS NOT NULL
    AND consent_at IS NOT NULL
    AND is_blocked = false
    AND marketing_opt_out = false;

CREATE TABLE appointment (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  staff_id               uuid NOT NULL REFERENCES staff (id),
  service_id             uuid NOT NULL REFERENCES service (id),
  client_id              uuid NOT NULL REFERENCES client (id),
  ref                    text NOT NULL UNIQUE,
  starts_at              timestamptz NOT NULL,
  -- Materialized: starts_at + duration_min + buffer_after_min. The EXCLUDE
  -- constraint needs it as a stored column, not an expression over a join.
  ends_at                timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'confirmed' CHECK (status IN (
                           'pending', 'confirmed', 'completed', 'cancelled_by_client',
                           'cancelled_by_staff', 'rescheduled', 'no_show', 'expired')),
  price_minor            int,
  comment                text,
  confirmed_by_client_at timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  rescheduled_from_id    uuid REFERENCES appointment (id) ON DELETE SET NULL,
  created_by             text NOT NULL DEFAULT 'client' CHECK (created_by IN ('client', 'staff')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- The double-booking guard. Two clients tapping the same slot at the same instant
-- is a first-week event, and no amount of application-level checking closes the
-- race: only the database can. Violations arrive as SQLSTATE 23P01.
--
-- The WHERE clause mirrors BLOCKING_STATUSES in packages/shared — a cancelled
-- appointment must stop reserving its span.
ALTER TABLE appointment ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));

CREATE INDEX appointment_tenant_starts_idx ON appointment (tenant_id, starts_at);
CREATE INDEX appointment_client_starts_idx ON appointment (client_id, starts_at DESC);
CREATE INDEX appointment_staff_starts_idx ON appointment (staff_id, starts_at);
-- The free-tier month counter and the no-show report both scan this.
CREATE INDEX appointment_tenant_status_starts_idx ON appointment (tenant_id, status, starts_at);

CREATE TABLE broadcast (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  text         text NOT NULL,
  media_id     uuid REFERENCES media (id) ON DELETE SET NULL,
  audience     jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN (
                 'draft', 'pending_moderation', 'approved', 'rejected',
                 'sending', 'sent', 'failed')),
  moderated_by bigint,
  total        int NOT NULL DEFAULT 0,
  sent         int NOT NULL DEFAULT 0,
  failed       int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX broadcast_tenant_idx ON broadcast (tenant_id, created_at DESC);

CREATE TABLE tg_update (
  id           bigserial PRIMARY KEY,
  bot_id       uuid NOT NULL REFERENCES bot (id),
  update_id    bigint NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);
-- Telegram retries an update whenever our reply is slow. This is what makes the
-- retry a no-op instead of a duplicate booking.
CREATE UNIQUE INDEX tg_update_bot_update_idx ON tg_update (bot_id, update_id);
CREATE INDEX tg_update_unprocessed_idx ON tg_update (received_at) WHERE processed_at IS NULL;

CREATE TABLE session (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  priority     int NOT NULL DEFAULT 100,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  finished_at  timestamptz,
  last_error   text,
  dedupe_key   text UNIQUE,
  cancel_key   text
);
CREATE INDEX job_ready_idx ON job (priority, run_at) WHERE finished_at IS NULL;
CREATE INDEX job_cancel_idx ON job (cancel_key) WHERE finished_at IS NULL;
-- The alerting query ("how deep is the queue") and the dead-letter view.
CREATE INDEX job_kind_idx ON job (kind, finished_at);

CREATE TABLE idempotency (
  key            text PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  appointment_id uuid,
  response       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_created_idx ON idempotency (created_at);

CREATE TABLE reminder_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointment (id) ON DELETE CASCADE,
  offset_min     int NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  delivered      boolean NOT NULL DEFAULT true,
  error          text
);
CREATE INDEX reminder_log_tenant_idx ON reminder_log (tenant_id, sent_at);
CREATE UNIQUE INDEX reminder_log_appt_offset_idx ON reminder_log (appointment_id, offset_min);
