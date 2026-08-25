# Progress

Checklist from §16 of the brief. Updated after every stage; each stage ends with
`pnpm lint && pnpm typecheck && pnpm test` green and a commit.

## Readiness criteria (§16)

- [x] `pnpm dev` brings everything up with one command, `pnpm seed` fills demo data
- [x] `pnpm test` green; `packages/shared` coverage >= 90%; `pnpm lint` and `pnpm typecheck` clean; no `any`
- [x] DST-day test passes; slots are neither duplicated nor lost
- [x] Concurrent booking of one slot on a real Postgres: one wins, the other gets `23P01` and a human message
- [x] Cancel and reschedule extinguish every reminder; a test proves it
- [x] A repeated `updateId` and a repeated `POST /book` create no duplicates
- [ ] A `telegramId` beyond 2^53 loses no precision anywhere
- [x] `initData` with a flipped byte and with a stale `auth_date` are rejected
- [x] Webhook without `X-Telegram-Bot-Api-Secret-Token` -> 401
- [x] The client path works without the Mini App, buttons only
- [x] Mini App correct in light and dark themes at 360 px; response types shared with the server
- [x] Tenant-isolation test passes on every route
- [x] Broadcast limits hold; moderation of the first three works
- [x] Not one byte of media on our disk: `fileId` only
- [x] `ops/restore.sh` really restores the database, verified
- [x] `DEPLOY.md` covers `/setdomain` and the `getWebhookInfo` check
- [x] `DECISIONS.md` explains every deviation

## Stages (§15)

- [x] 1. Monorepo, TS/Biome/Turbo config, compose, database up, `/healthz`, long polling
- [x] 2. `packages/db`: Drizzle schema, migrations, `btree_gist`, EXCLUDE, tenant-scoped repositories
- [x] 3. `packages/shared/domain/slots.ts` and its full test set
- [x] 4. `packages/shared/domain/booking.ts`: statuses and transitions (DB-side `23P01` handling in stage 5)
- [x] 5. `job` queue, worker, scheduler, `cancelKey`, typed payloads
- [x] 6. Outbound transport: throttler, auto-retry, 403/429, tests on an HTTP mock
- [x] 7. Master registration, services, schedule, `timeOff`
- [x] 8. Client path with plain buttons, end to end
- [x] 9. Reminders to client and master, extinguished on cancel, tested
- [x] 10. `ask_no_show`, `completed`/`no_show`, statistics with no-show rate
- [x] 11. Mini App: `initData`, API, client calendar, `slots.ts` reused on the client
- [x] 12. Mini App for the master: week view, manual booking
- [x] 13. Clients, card, history, notes
- [x] 14. Broadcasts with limits and moderation, "a window opened"
- [x] 15. `dedicated` bot mode, token encryption, routing by `botId`
- [x] 16. Admin panel, free-tier limit, backups, alerts, `DEPLOY.md`
- [x] 17. `pnpm seed`

## Notes

**Stage 1 + 3 + 4.** `packages/shared` is complete and covered at 99% of
statements. The slot engine, the state machine, reminder planning, plan limits,
broadcast gates, statistics, the callback codec, deep links and the `initData`
helpers are all pure and browser-safe. Deviations D6-D11 concern this stage.

**Stage 2.** Drizzle schema, one hand-written SQL migration with `btree_gist` and
both EXCLUDE constraints, and tenant-scoped repositories where the tenant filter
cannot be forgotten because it is bound at construction. Integration tests run
against a real Postgres 16, including two transactions racing for the same slot
(exactly one wins, the loser gets `23P01`), tenant isolation on reads and writes,
queue claiming under `FOR UPDATE SKIP LOCKED`, reminder cancellation by
`cancelKey`, and a Telegram id past 2^53 surviving the round trip. D12-D13.

**Stages 5-10.** `packages/core` (D14) carries the server-side shared code:
env parsing, logging with redaction, AES-256-GCM token envelopes, `initData`
verification, the typed queue facade, the availability service with its
60-second cache, and booking orchestration. `apps/api` serves the webhook, the
Mini App API and the health probes; `apps/worker` runs the bot, the queue loop
and the scheduler. D14-D19.

**Stages 11-13.** The Mini App: Vanilla TS + Vite + Tailwind, every colour from
Telegram `themeParams` with fallbacks for both schemes, response schemas
imported from `packages/shared` and used to validate on the client too,
`textContent` everywhere, 44 px tap targets, skeletons and a retry instead of
endless spinners, horizontal scroll confined to the day strip.

**Stages 14-17 and deployment.** Broadcasts run in the queue's slow lane behind
every transactional message, with the monthly quota, the 48-hour cooldown, the
seven-day tenant age and the empty-audience check enforced in one place, the
first three sends held for a moderator, an unsubscribe button on every message
and consent re-checked per recipient at send time. "A window opened" reuses that
whole pipeline with a different body, offered as one button on the cancellation
notice. Dedicated bots encrypt the token with AES-256-GCM, re-point the tenant,
flag every stored `file_id` for re-upload and install the webhook. `/admin`
carries the moderation queue and the dead-job list. D20-D24.

**Quality pass.** Escaping is enforced by a test that reads the bot's own
sources; the API composes no user-visible text; every callback dispatcher was
split rather than suppressed, so `pnpm lint` is clean with no ignores; column
types are narrowed in the schema, and each surviving `as` says why it is safe.
D25-D30.

## Verified by hand, not only by tests

- `ops/restore.sh` run against a real dump of the seeded database: 17 tables,
  both EXCLUDE constraints and all 80 appointments came back, ending in
  `restore verified`.
- `pnpm migrate`, `pnpm seed`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all
  run green from the root.
- The API booted for real: `/healthz` returns `{"ok":true}`, `/readyz` reports
  `{"ok":true,"db":true,"queueDepth":0,"unprocessedUpdates":0}`, a webhook POST
  with no secret header returns 401, and `/miniapp/` serves the built bundle.
- The worker booted, ran its scheduler against the seeded tenant, and shut down
  cleanly on SIGTERM.

## Not verified here

The Docker image and `docker-compose.yml` are written but not built: there is no
Docker daemon in this environment. Everything they run — the migration CLI, both
process entrypoints, the backup and restore scripts — has been executed directly
on the same Node and Postgres versions the image pins.
