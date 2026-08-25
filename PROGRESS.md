# Progress

Checklist from §16 of the brief. Updated after every stage; each stage ends with
`pnpm lint && pnpm typecheck && pnpm test` green and a commit.

## Readiness criteria (§16)

- [ ] `pnpm dev` brings everything up with one command, `pnpm seed` fills demo data
- [x] `pnpm test` green; `packages/shared` coverage >= 90%; `pnpm lint` and `pnpm typecheck` clean; no `any`
- [x] DST-day test passes; slots are neither duplicated nor lost
- [ ] Concurrent booking of one slot on a real Postgres: one wins, the other gets `23P01` and a human message
- [ ] Cancel and reschedule extinguish every reminder; a test proves it
- [ ] A repeated `updateId` and a repeated `POST /book` create no duplicates
- [ ] A `telegramId` beyond 2^53 loses no precision anywhere
- [ ] `initData` with a flipped byte and with a stale `auth_date` are rejected
- [ ] Webhook without `X-Telegram-Bot-Api-Secret-Token` -> 401
- [ ] The client path works without the Mini App, buttons only
- [ ] Mini App correct in light and dark themes at 360 px; response types shared with the server
- [ ] Tenant-isolation test passes on every route
- [ ] Broadcast limits hold; moderation of the first three works
- [ ] Not one byte of media on our disk: `fileId` only
- [ ] `ops/restore.sh` really restores the database, verified
- [ ] `DEPLOY.md` covers `/setdomain` and the `getWebhookInfo` check
- [x] `DECISIONS.md` explains every deviation

## Stages (§15)

- [x] 1. Monorepo, TS/Biome/Turbo config, compose, database up, `/healthz`, long polling
- [ ] 2. `packages/db`: Drizzle schema, migrations, `btree_gist`, EXCLUDE, tenant-scoped repositories
- [x] 3. `packages/shared/domain/slots.ts` and its full test set
- [x] 4. `packages/shared/domain/booking.ts`: statuses and transitions (DB-side `23P01` handling in stage 5)
- [ ] 5. `job` queue, worker, scheduler, `cancelKey`, typed payloads
- [ ] 6. Outbound transport: throttler, auto-retry, 403/429, tests on an HTTP mock
- [ ] 7. Master registration, services, schedule, `timeOff`
- [ ] 8. Client path with plain buttons, end to end
- [ ] 9. Reminders to client and master, extinguished on cancel, tested
- [ ] 10. `ask_no_show`, `completed`/`no_show`, statistics with no-show rate
- [ ] 11. Mini App: `initData`, API, client calendar, `slots.ts` reused on the client
- [ ] 12. Mini App for the master: week view, manual booking
- [ ] 13. Clients, card, history, notes
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
