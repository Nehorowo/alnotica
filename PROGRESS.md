# Progress

Checklist from §16 of the brief. Updated after every stage; each stage ends with
`pnpm lint && pnpm typecheck && pnpm test` green and a commit.

## Readiness criteria (§16)

- [ ] `pnpm dev` brings everything up with one command, `pnpm seed` fills demo data
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
- [ ] Broadcast limits hold; moderation of the first three works
- [ ] Not one byte of media on our disk: `fileId` only
- [ ] `ops/restore.sh` really restores the database, verified
- [ ] `DEPLOY.md` covers `/setdomain` and the `getWebhookInfo` check
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
- [ ] 14. Broadcasts with limits and moderation, "a window opened"
- [ ] 15. `dedicated` bot mode, token encryption, routing by `botId`
- [ ] 16. Admin panel, free-tier limit, backups, alerts, `DEPLOY.md`
- [ ] 17. `pnpm seed`

## Notes

**Stage 1 + 3 + 4.** `packages/shared` is complete and covered at 99% of
statements (179 tests). The slot engine, the state machine, reminder planning,
plan limits, broadcast gates, statistics, the callback codec, deep links and the
`initData` helpers are all pure and browser-safe. Deviations are recorded in
`DECISIONS.md` (D6-D11 concern this stage).

**Stage 2.** `packages/db` is complete: Drizzle schema, one hand-written SQL
migration with `btree_gist` and both EXCLUDE constraints, and tenant-scoped
repositories where the tenant filter cannot be forgotten because it is bound at
construction. 37 integration tests run against a real Postgres 16, including two
transactions racing for the same slot (exactly one wins, the loser gets `23P01`),
tenant isolation on reads and writes, queue claiming under `FOR UPDATE SKIP
LOCKED`, reminder cancellation by `cancelKey`, and a Telegram id past 2^53
surviving the round trip. Deviations D12-D13 concern this stage.

**Stages 5-10.** `packages/core` (D14) carries the server-side shared code: env
parsing, logging with redaction, AES-256-GCM token envelopes, `initData`
verification, the typed queue facade, the availability service with its 60-second
cache, and booking orchestration. `apps/api` serves the webhook, the Mini App API
and the health probes; `apps/worker` runs the bot, the queue loop and the
scheduler.

276 tests pass, `packages/shared` is at 99% of statements. The suite now covers,
end to end and against a real Postgres and a real grammY client on a mock
transport: a webhook without the secret header answering 401 and writing nothing;
a repeated `update_id` and a repeated `Idempotency-Key` producing no duplicates;
`initData` rejected for a flipped byte, for tampered data, for another bot's
token and for a stale `auth_date`; tenant isolation answering 404 on every route;
`429` retried within the plugin budget then deferred then finally buried; `403`
flagging the client while leaving the booking intact; cancellation and reschedule
extinguishing every scheduled reminder; and the full deep-link-to-cancellation
client journey driven through the real webhook. Deviations D14-D19 concern these
stages.
