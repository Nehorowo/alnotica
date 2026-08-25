# Alnotica

Online booking and a small CRM for a single-master business, living entirely
inside Telegram. A groomer, a masseur, a tattooist, a tutor, a two-bay garage
registers in the bot, sets up services and a schedule, and gets a link like
`t.me/OurBot?start=m_k3n7p2qa` to put in their profile bio. Their client opens
it, picks a service, sees free slots, and books — no website, no sign-up.

**The product is not "convenient booking". It is "fewer no-shows."** Automatic
reminders take no-shows from roughly 20% to 7–8%. For a master with a 3 000 ₽
average ticket and 200 bookings a month that is about 70 000 ₽ a month. So the
reminder chain, its reliability, and the no-show report are the core — everything
else is around them.

## Quick start

```bash
cp .env.example .env      # fill in BOT_TOKEN and the two secrets
pnpm install
pnpm migrate
pnpm seed                 # demo tenant with a month of history
pnpm dev                  # api + worker + mini app, one command
```

Development uses long polling (`WEBHOOK_MODE=off`), so no public HTTPS is
needed. Production uses webhooks — see [DEPLOY.md](DEPLOY.md).

## Layout

```
apps/api        Fastify: the webhook (store the update, return 200, done),
                the Mini App API, the Mini App bundle, /healthz and /readyz
apps/worker     the bot itself, the queue loop, the scheduler, alerting
apps/miniapp    Vite + Tailwind, built to static files served by the API
packages/shared types, Zod schemas and pure domain logic — slot generation,
                the appointment state machine, reminder planning, statistics.
                No Node built-ins: this runs in the browser too
packages/core   server-side shared code: env, logging, crypto, the queue
                facade, booking orchestration, the grammY registry
packages/db     Drizzle schema, SQL migrations, tenant-scoped repositories
```

## The parts that carry the product

**Slot generation** (`packages/shared/src/domain/slots.ts`) is pure and runs
unchanged in the browser, so the Mini App draws the grid with the same code that
validates the booking on the server. All local-time arithmetic goes through
Luxon with an explicit zone; a day that is 23 or 25 hours long produces exactly
the slots that exist.

**Double booking is settled by the database.** An `EXCLUDE USING gist`
constraint on `appointment` makes an overlap impossible, however the race
arrives. Violations come back as SQLSTATE `23P01` and turn into "someone just
took that slot, here is what is still free".

**Reminders are extinguished, not merely stopped.** Every job for an appointment
carries the same `cancel_key`, so cancelling or rescheduling kills all of them in
one statement. A client who cancels and gets reminded anyway has stopped trusting
the product, and there is a test whose only job is to make that impossible to
reintroduce.

**We store no media.** Only Telegram `file_id`s. Disk grows with rows, never with
content.

## Commands

| | |
|---|---|
| `pnpm dev` | api, worker and the Mini App together |
| `pnpm test` | Vitest, against a real Postgres |
| `pnpm lint` / `pnpm typecheck` | Biome and `tsc --noEmit` |
| `pnpm migrate` / `pnpm seed` | schema and demo data |
| `pnpm set-webhook` | install the webhook and print `getWebhookInfo` |

Tests need a Postgres 16 with `btree_gist`; put its URL in `.env.test`
(see `.env.test.example`) or set `TEST_DATABASE_URL`.

## Reading further

- [DECISIONS.md](DECISIONS.md) — every deviation from the brief, with the reason
- [PROGRESS.md](PROGRESS.md) — the readiness checklist
- [DEPLOY.md](DEPLOY.md) — BotFather (including `/setdomain`), DNS, TLS,
  migrations, the webhook, backups and their verification
