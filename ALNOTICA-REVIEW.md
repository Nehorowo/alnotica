# Alnotica — implementation snapshot

A self-contained description of one implementation of the "Telegram booking SaaS"
brief, written so it can be compared against another implementation of the same
brief in a chat that has no access to this repository.

Everything below is measured, not remembered. §10 lists the commands that
reproduce the numbers, and §9 lists what is *not* done.

---

## 1. The product, in one paragraph

A master (groomer, masseur, tattooist, tutor, two-bay garage) registers in a
Telegram bot, sets up services and a schedule, and gets a link —
`t.me/OurBot?start=m_k3n7p2qa` — to put in their profile bio. Their client opens
it, picks a service, sees free slots, and books, all inside Telegram. The service
then sends reminders 24 hours and 2 hours ahead, keeps a visit history, and shows
the master their no-show rate.

**The product is not "convenient booking", it is "fewer no-shows."** Reminders
take no-shows from ~20% to ~7–8%; at a 3 000 ₽ ticket and 200 bookings a month
that is ~70 000 ₽/month. So the reminder chain, its reliability, and the no-show
report are the core, and everything else is arranged around them.

Explicit non-goals in the brief: no web admin panel, no online payments, no
inventory or payroll, no multi-branch, no recurring bookings, no Google Calendar
(interface only), no SMS or email, no public API, no runtime billing beyond one
free-tier cap.

---

## 2. Measured state

| | |
|---|---|
| Tests | **374**, across 20 files, all passing |
| Coverage of `packages/shared` | **99.38%** statements, 94.7% branches, **100%** functions |
| `pnpm lint` (Biome) | clean, 144 files, **zero suppressions** |
| `pnpm typecheck` | clean, 9 projects, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `any` in source | **0** |
| Source TypeScript | ~12 500 lines (99 files, excluding tests) |
| Test TypeScript | ~5 400 lines |
| SQL migration | 268 lines, hand-written |
| Database tables | 16 |
| Commits | 9, each one green before it landed |

Tests are not mocked at the layer that matters: database tests run against a real
PostgreSQL 16 with `btree_gist`, and bot tests run the real grammY client
(throttler and auto-retry plugins included) against a mock Bot API at the **HTTP**
level, so the code under test is the shipping code.

---

## 3. Stack

Node 22 locally / `node:24-alpine` in the image, ESM, TypeScript 5.7 `strict`.

| Layer | Choice | Version |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | turbo ^2.3.3 |
| Bot | grammY (webhook + long polling) | ^1.32.0 |
| | `@grammyjs/auto-retry`, `@grammyjs/transformer-throttler` | ^2.0.2 / ^1.2.1 |
| HTTP | Fastify | ^5.2.0 |
| Database | PostgreSQL 16 + `btree_gist` | — |
| ORM / driver | Drizzle ORM + postgres.js | ^0.38.2 / ^3.4.5 |
| Validation | Zod | ^3.24.1 |
| Date/time | Luxon (never native `Date` for local arithmetic) | ^3.5.0 |
| Mini App | Vanilla TS + Vite + Tailwind + `@twa-dev/types` | ^6.0.5 / ^3.4.17 |
| Tests | Vitest (+ jsdom for the Mini App) | ^2.1.8 |
| Lint/format | Biome | ^1.9.4 |
| Logs | Pino, JSON to stdout, with `redact` | ^9.5.0 |
| Proxy | Caddy 2 (automatic TLS) | — |

No Redis, no BullMQ, no broker: **the queue is a Postgres table**, claimed with
`FOR UPDATE SKIP LOCKED`. grammY sessions are stored in Postgres, not in memory.

---

## 4. Layout

```
apps/api        Fastify: webhook (store update, return 200, done), Mini App API,
                Mini App static bundle, /healthz, /readyz
apps/worker     the bot itself, the queue loop, the scheduler, alerting, CLI
apps/miniapp    Vite + Tailwind, built to static files served by the API
packages/shared types, Zod schemas, pure domain logic — slot generation, the
                appointment state machine, reminder planning, statistics,
                plan/broadcast limits, callback codec, deep links, initData
                helpers. No Node built-ins: this bundles for the browser
packages/core   server-side shared code: env, logging, crypto, initData HMAC,
                queue facade, availability, booking orchestration, bot registry
packages/db     Drizzle schema, SQL migrations, tenant-scoped repositories
```

`packages/core` is a **deviation**: the brief lists five workspaces. Both apps
need the same env parsing, AES envelope, `initData` HMAC and booking
orchestration; putting that in `shared` would break the one hard rule about it
(no Node built-ins, so it can bundle for the Mini App), and duplicating it across
the two apps would guarantee drift.

**Tables (16):** `bot, tenant, media, staff, service, staff_service,
working_hours, time_off, client, appointment, broadcast, tg_update, session, job,
idempotency, reminder_log`.

**Job kinds (7):** `process_update, send_message, reminder, broadcast_chunk,
ask_no_show, daily_digest, notify_booking`.

**HTTP surface (8 routes):** `POST /tg/:botHash`, `GET /healthz`, `GET /readyz`,
`GET|POST /api/miniapp/:slug/{services,availability,book,schedule,staff-book}`.

---

## 5. Readiness checklist

The brief's §16, with where each is proven.

| Criterion | State | Evidence |
|---|---|---|
| `pnpm dev` starts everything; `pnpm seed` fills demo data | done | run by hand: builds, migrates, starts api + worker + Vite with prefixed output, Ctrl-C stops all three |
| Tests green, shared coverage ≥ 90%, lint/typecheck clean, no `any` | done | 374 tests, 99.38% |
| DST-day test passes; slots neither duplicated nor lost | done | `slots.test.ts` — spring forward, fall back, a shift starting inside the gap, and a day whose local midnight does not exist |
| Concurrent booking on real Postgres: one wins, other gets `23P01` | done | `db.test.ts` — two transactions holding inserts open, `Promise.allSettled`, asserted on SQLSTATE |
| Cancel and reschedule extinguish every reminder | done | `reminders.test.ts` — 14 tests, including one where a job *survives* the cancellation and the handler still refuses to send |
| Repeated `updateId` and repeated `POST /book` create no duplicates | done | `webhook.test.ts`, `miniapp.test.ts` |
| `telegramId` beyond 2^53 loses no precision | done | `db.test.ts` round trip + `util.test.ts` + `schemas.test.ts` |
| `initData` with a flipped byte / stale `auth_date` rejected | done | `miniapp.test.ts` — 7 tests incl. tampered payload and another bot's token |
| Webhook without the secret header → 401 | done | `webhook.test.ts` — and asserts nothing was written |
| Client path works without the Mini App | done | `e2e.test.ts` — full journey through the real webhook, buttons only |
| Mini App correct in light and dark at 360 px; shared response types | done | `miniapp.test.ts` (jsdom) — 13 tests |
| Tenant isolation on every route | done | `miniapp.test.ts` + `db.test.ts` — cross-tenant ids return **404, never 403** |
| Broadcast limits; moderation of the first three | done | `broadcasts.test.ts` — 16 tests |
| Not one byte of media on disk: `file_id` only | done | `db.test.ts`, `plan-and-bots.test.ts` |
| `ops/restore.sh` really restores, verified | done | run against a real dump: 17 tables (16 + `schema_migration`), both EXCLUDE constraints, all 80 appointments |
| `DEPLOY.md` covers `/setdomain` and `getWebhookInfo` | done | 264 lines, both with the failure mode spelled out |
| `DECISIONS.md` explains every deviation | done | 32 numbered decisions |

---

## 6. Comparison kit: the fourteen things worth checking

These are the places where an implementation that *looks* complete usually is
not. Each is phrased as a check another implementation can be held to.

**1. DST gaps.** The brief says a nonexistent local time surfaces in Luxon as
`DateTime.invalid`. **It does not.** Luxon returns a *valid* DateTime rolled
forward by the gap: `02:30` on a spring-forward day comes back as `03:30` with
`isValid === true`. An implementation that checks `.isValid` has the exact bug the
brief was trying to prevent. *Check: does it round-trip the wall clock
(`dt.hour === requested`) or trust `.isValid`?*

**2. DST fall-back.** On a 25-hour day the same wall clock names two distinct
instants. Dropping one makes an hour unbookable once a year; showing two
identical `02:00` buttons is a support ticket. *Check: is the case handled at all?
(Here both are kept and flagged `ambiguous`, and the UI appends the UTC offset.)*

**3. The slot grid walked in real time, not UTC arithmetic.** "Day start + N
minutes" in UTC silently breaks across a transition. *Check: is the grid stepped
from a zoned instant?*

**4. `EXCLUDE USING gist` with a matching `WHERE`.** The constraint must be
`WHERE (status IN ('pending','confirmed'))` and that list must equal the code's
"blocking statuses", or a cancelled booking keeps reserving its slot. *Check: does
the constraint exist, does it have the WHERE clause, and is the overlap test
`tstzrange(...,'[)')` (half-open, so touching at the boundary is allowed)?*

**5. The concurrency test must be concurrent.** Two sequential inserts prove
nothing — the second always fails. *Check: do two transactions hold their inserts
open before either commits?*

**6. `23P01` caught by code, not message text.** Postgres messages are localized.
*Check: SQLSTATE, and ideally the constraint name too.*

**7. The dedupe key must be released on cancel.** If `cancel_key` cancellation
leaves `dedupe_key` set, a rolled-back reschedule can never re-create the
reminders it just cancelled — the dead row still owns the key and every re-insert
is silently dropped, leaving the restored appointment **with no reminders at
all**. This one was found by a test here, not by reading. *Check: does cancelling
null the dedupe key, and is there a test for the rollback path?*

**8. The reminder handler re-reads the appointment.** Belt to `cancelByKey`'s
braces. *Check: is there a test where a reminder job survives a cancellation and
the handler still refuses to send?*

**9. `initData` HMAC.** Three traps: the key/message order is
`HMAC(key="WebAppData", msg=botToken)` then `HMAC(key=secret, msg=dataCheckString)`
— swapping them rejects everything; the sort must be by **code point**, not
`localeCompare`, which is locale-dependent and gives a floating bug; and the
`signature` field must be excluded. *Check also: is `auth_date` max age different
for reads (24h) and writes (15min)?*

**10. `callback_data` is 64 **bytes**, not characters.** JSON spends a third of
the budget on braces and quotes, so `appt_ok|o=noshow|id=<uuid>` as JSON does not
fit. Cyrillic costs two bytes a letter. *Check: is the limit enforced at encode
time, and is the data Zod-parsed on the way back in rather than `split(':')`?*

**11. `answerCallbackQuery` always fires.** Otherwise the client watches a
spinner forever. *Check: is it middleware that fires even when the handler throws,
and is there a test that sends deliberately broken callback data?*

**12. Tenant isolation answers 404, not 403.** A 403 confirms the row exists.
*Check: is every route tested with a *valid* caller from tenant A passing tenant
B's identifiers?*

**13. Button labels must NOT be HTML-escaped.** Message bodies are
`parse_mode: HTML` and must escape `Стрижка <люкс> & укладка`; button labels are
plain text and escaping one shows the master `Стрижка &lt;люкс&gt;`. *Check: are
the two treated differently, and is escaping enforced by something other than
discipline?* (Here: a test that reads the bot's own sources and fails on any
user-controlled field interpolated without `esc()` or the `html` tag — and the
rule is itself tested against a synthetic violation so it cannot rot into a no-op.)

**14. `drizzle()` mutates the postgres.js client.** It replaces the
`timestamptz`/`timestamp`/`date`/`time` serializers with identity functions. After
that line a hand-written ``sql`... ${someDate} ...` `` fails deep inside the
driver with a type error naming neither Drizzle nor the column. *Check: do raw
queries pass `date.toISOString()` with an explicit `::timestamptz` cast?* This is
obscure enough that hitting it is good evidence the code was actually run.

**Two more, lower signal but telling:** `UPDATE ... RETURNING` has no ordering
guarantee, so a priority queue must re-sort in the application (and raw SQL
returns timestamps as *text* through a field typed `Date`); and the free-tier cap
must block client bookings while leaving the master's own bookings and all
existing appointments working.

---

## 7. Legitimate forks

Places where a different implementation can reasonably differ and still be right.
Worth identifying as *choices* rather than scoring as defects.

- **No-show denominator.** Here `no_show / (completed + no_show)` — cancellations
  excluded, because someone who cancelled in time is not a no-show and including
  them flatters a tenant with many polite cancellations.
- **Where expiry lives.** Here a one-minute indexed sweep, not a per-appointment
  scheduled job. (The first draft *was* a job, typed as a `reminder` with a
  one-minute offset, which would have **sent a reminder** instead of expiring
  anything.)
- **Auto-completion.** After 48 hours of silence a past visit becomes
  `completed`, not `no_show` — guessing the other way inflates the very metric the
  master is judged on, from nothing but their own silence.
- **Moderated broadcasts count against the monthly quota**, and the 48-hour
  cooldown runs from submission, not delivery. Otherwise a new tenant queues a
  dozen while the moderator sleeps and sends them all at once on approval.
- **Button-first, Mini App second.** The brief calls the plain-button path a
  fallback; here it is the primary implementation and the Mini App button is one
  extra keyboard row. Building the button path second tends to mean building it
  badly.
- **Hand-written SQL migrations**, with drizzle-kit kept only for generation. Two
  constraints cannot be expressed in the Drizzle schema at all, so a generated
  migration always needs hand-editing, and mixing the two in one directory makes
  it impossible to tell which is which.

---

## 8. Bugs the tests caught

Not prevented — *found*, during the build, by tests written alongside the code.
A rival implementation without an equivalent suite plausibly still has these.

1. **`cancelByKey` did not release the dedupe key**, so a rolled-back reschedule
   restored an appointment with no reminders at all.
2. **A `429` with a long `retry_after` bypassed the attempt budget** — a
   permanently flooded chat would have cycled for the lifetime of the deployment.
3. **The worker's queue loop blocked on a `getMe` round trip**, so an unreachable
   Bot API stopped *reminders* being sent — and reminders need nothing from
   Telegram until the moment they go out.
4. **Expiring an unconfirmed booking was queued as a `reminder` job**, so the
   handler would have sent a reminder rather than expiring anything.
5. **`jobRepo.claim` returned timestamps as text** through a field typed `Date` —
   the kind of lie that surfaces three files away as a `NaN`.

---

## 9. Not done / not verified

Stated plainly so a comparison is fair in both directions.

- **The Docker image has never been built.** `Dockerfile`, `docker-compose.yml`
  and `Caddyfile` are written, but there is no Docker daemon in the build
  environment. Everything they *run* — both entrypoints, the migration CLI, the
  backup and restore scripts — was executed directly on the same Postgres 16 the
  compose file pins; the image pins `node:24-alpine` while the build machine has
  Node 22, so the multi-stage build is the one artifact without a real run.
- **No live Telegram.** Every Bot API interaction is against a mock HTTP server.
  Real `setWebhook`, real `/setdomain`, and the Mini App rendering inside the
  actual Telegram WebView are untested.
- **Testcontainers is optional, not mandatory** as the brief asks. With no Docker
  daemon, the DB harness takes `TEST_DATABASE_URL` when set and falls back to
  Testcontainers otherwise. The alternative was shipping the EXCLUDE tests unrun,
  which is the one thing the brief says not to cut.
- **Staff Mini App is read-plus-create, not full editing.** Week view and manual
  booking work; dragging an appointment to a new slot does not exist (the bot does
  reschedules).
- **Broadcast media** (`mediaId` on a broadcast) is stored and plumbed but the
  send path posts text only.
- **i18n is structural, not actual.** All strings are in one typed `texts.ts`
  object shaped for a second language; only Russian exists.
- **`CalendarSync`** is an interface plus a no-op, as the brief specifies.

---

## 10. Reproducing the numbers

Needs Node ≥ 22, pnpm, and a PostgreSQL 16 with `btree_gist`.

```bash
pnpm install
echo 'TEST_DATABASE_URL=postgres://user:pass@localhost:5432/alnotica_test' > .env.test

pnpm lint                      # Biome, expect: clean
pnpm typecheck                 # tsc -b across 9 projects, expect: clean
pnpm test                      # expect: 374 passed
pnpm exec vitest run --coverage # expect: shared ≥ 90%

DATABASE_URL=... pnpm migrate
DATABASE_URL=... pnpm seed     # 4 services, 2 masters, 60 past + 20 upcoming
DATABASE_URL=... bash ops/backup.sh
DATABASE_URL=... bash ops/restore.sh backups/<dump>.sql.gz   # ends "restore verified"
```

The database tests truncate every table in `TEST_DATABASE_URL`, so point it at a
throwaway database. Vitest runs files in parallel and gives each worker its own
schema (`test_<n>`, with `search_path` falling back to `public`).

Companion documents in the repo: `DECISIONS.md` (32 numbered deviations with
reasons), `PROGRESS.md` (the stage-by-stage checklist and what was verified by
hand), `DEPLOY.md` (BotFather including `/setdomain`, DNS, TLS, migrations,
webhook registration, backups and their verification).
