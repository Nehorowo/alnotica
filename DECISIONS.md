# Decisions

Every deviation from the specification, and every judgement call the spec left
open, with the reason. Newest sections are appended at the end.

## Environment

### D1. Node 22 in development, Node 24 in the image
The spec asks for Node 24 LTS. The build machine ships Node 22.22; the Docker
image pins `node:24-alpine`, `engines.node` is `>=22`, and nothing in the code
uses an API newer than Node 22, so both run the same source. `@types/node` is
pinned to `^22` so type-checking matches the lower bound rather than the upper —
if it type-checks on 22 it type-checks on 24.

### D2. Testcontainers is optional, not mandatory
The spec asks for Testcontainers. There is no Docker daemon in this environment,
so `packages/db/src/testing` takes a Postgres connection from `TEST_DATABASE_URL`
when one is set and starts a Testcontainers Postgres otherwise. The database
tests are identical in both cases and run against a real Postgres 16 with
`btree_gist`; only the way the server is obtained differs. A hard dependency on
Docker would have meant shipping the EXCLUDE-constraint tests unrun, which is the
one thing the spec says not to cut.

## Schema and migrations

### D3. Hand-written SQL migrations, drizzle-kit kept for generation only
The spec allows both. Every migration in `packages/db/migrations` is plain SQL
applied by a small runner with an advisory lock. Two of the constraints the
product depends on (`EXCLUDE USING gist ... WHERE`) cannot be expressed in the
Drizzle schema at all, so a generated migration would always need hand-editing
afterwards; mixing generated and hand-written files in one directory makes it
impossible to tell which is which. The Drizzle schema remains the source of
truth for *queries* and types.

### D4. `job` keeps the spec's columns; "dead" is derived
The spec's `job` table has no column for dead-lettering but asks for dead jobs to
be visible in the admin panel. Rather than add a column, `last_error` is cleared
on success, so a dead job is exactly
`finished_at IS NOT NULL AND last_error IS NOT NULL AND last_error <> 'cancelled'`.
One less column to keep consistent.

### D5. `bigint` mode chosen per column, not globally
`staff.telegram_id` and `client.telegram_id` are read as JavaScript `bigint`:
they are the values that exceed 2^53. `job.id`, `tg_update.id` and
`tg_update.update_id` are read as `number`: they are our own sequences and
Telegram's own update counter, none of which can approach 2^53 in this product's
lifetime, and `number` keeps the queue code readable. postgres.js is configured
with an explicit `types.bigint` codec rather than relying on the driver default.

## Domain

### D6. DST gaps are detected by round-tripping, not by `isValid`
The spec says a nonexistent local time surfaces in Luxon as `DateTime.invalid`.
It does not. Luxon returns a **valid** DateTime rolled forward by the length of
the gap: `02:30` on a spring-forward day comes back as `03:30`, `isValid === true`.
`resolveLocal` therefore compares the resulting wall clock against the requested
one and reports `shifted` when they differ. Trusting `.isValid` here would have
been the exact bug the spec was trying to prevent.

A working stretch whose boundary lands in the gap is rolled forward rather than
dropped, so a shift written as "02:30–18:00" still exists on that day.

### D7. Ambiguous times are kept and flagged, not deduplicated
On a fall-back day the same wall clock names two different instants. Both are
real and bookable, so both are offered; `Slot.ambiguous` marks them and the UI is
expected to disambiguate (by offset). Silently dropping one would make an hour of
the master's day unbookable once a year; silently showing two identical "02:00"
buttons would be a support ticket.

### D8. The no-show denominator excludes cancellations
`noShowRate = no_show / (completed + no_show)`. Counting cancellations in the
denominator dilutes the number the master is paying attention to — someone who
cancelled in time is not a no-show, and a tenant with many polite cancellations
would appear to have a better no-show rate than they do.

### D9. `correctOutcome` is the only path between terminal statuses
The spec's state machine has no way back from `no_show`. In practice masters tap
the wrong button, and this feeds the product's headline metric, so a narrow,
explicit correction between `completed` and `no_show` exists. Everything else
stays terminal.

### D10. Callback data uses a compact `a|k=v` codec, not JSON
`callback_data` is limited to 64 **bytes**. JSON spends roughly a third of that
on braces and quotes, which pushes `appt_ok|o=noshow|id=<uuid>` over the limit.
The codec is still schema-validated with Zod on the way in — the saving is in the
encoding, not in the checking.

### D11. `verifyInitData` lives in the API, its pure parts in `shared`
`packages/shared` is bundled for the browser, so it must not import
`node:crypto`. Everything except the HMAC itself (splitting, the code-point sort,
`auth_date` freshness, user parsing) is in `shared/telegram/init-data.ts`, and
`apps/api` supplies the HMAC. The code-point sort — the thing the spec warns
about — is therefore covered by the shared unit tests.

### D12. Raw SQL passes timestamps as ISO strings, not `Date`
`drizzle()` mutates the postgres.js client it is handed: it replaces the
serializers and parsers for `timestamptz`, `timestamp`, `date` and `time` with
identity functions so that it can control the representation itself. After that
line a hand-written ``sql`... ${someDate} ...` `` fails deep inside the driver
with a type error that names neither Drizzle nor the column. Every raw query in
this codebase therefore passes `date.toISOString()` with an explicit
`::timestamptz` cast, and `client.ts` says why.

### D13. `job.dead` means "finished and still carrying an error"
Not "attempts >= max_attempts". The worker is the only thing that gives up, and
it does so by calling `fail(id, err, null)` — sometimes before the attempt budget
is spent, when the error is clearly permanent. Deriving deadness from the attempt
counter would have hidden exactly those jobs from the admin panel.

## Architecture

### D14. A sixth package, `packages/core`, for server-side shared code
The brief lists five workspaces. Both `apps/api` and `apps/worker` need the same
env parsing, logger, AES envelope, `initData` HMAC, queue facade, availability
service, booking orchestration and bot registry. Putting that in
`packages/shared` would break the one hard rule about it — that it stays free of
Node built-ins so it can be bundled for the Mini App. Duplicating it across the
two apps would guarantee they drift. `packages/core` depends on `shared` and
`db`, is never imported by the browser bundle, and keeps `shared` genuinely
isomorphic.

### D15. The plain-button booking path is the primary implementation
The brief calls the non-Mini-App route a fallback. It is written here as the main
path — the Mini App button is one extra row on the same keyboard — because the
button path is the one that works on every Telegram client, and building it
second tends to mean building it badly.

### D16. `slot_taken` and `slot_not_available` are different answers
The booking gate classifies a rejected start into `taken` (on the published grid,
but occupied) and `off_grid` (not a time we offer). The first gets "someone just
took it, here is what is left" plus live alternatives; the second gets "choose
another time". Collapsing the two would show the wrong message in the case that
actually happens to real clients.

### D17. A cancelled job releases its dedupe key
`cancelByKey` nulls `dedupe_key` as well as finishing the row. Without it, a
reschedule that has to roll back could never restore the reminders it had just
cancelled: the dead row would still own the key and every re-insert would be
dropped silently, leaving the restored appointment with no reminders. A test
covers exactly this path.

### D18. The attempt budget also applies to Telegram-requested delays
A `429` with a long `retry_after` sends the job back to the queue rather than
parking a worker — but it still counts as an attempt. Otherwise a chat that
floods us forever produces a job that cycles for the lifetime of the deployment.

### D19. Test workers get a schema each
Vitest runs files in parallel and each database test truncates every table in
`beforeEach`. Sharing one schema means one file wiping another's fixtures
mid-assertion. Each worker gets `test_<n>` with `search_path` falling back to
`public`, so extensions stay shared and the suite stays parallel.
