# Deploying Alnotica

One VDS, one `docker compose up`. Roughly forty minutes end to end, most of it
waiting for DNS.

---

## 0. What you need first

- A domain pointed at the server (an A record; TLS is automatic).
- Docker Engine 24+ with the Compose plugin.
- Ports 80 and 443 open. Telegram will not talk to anything else.

---

## 1. BotFather

Open [@BotFather](https://t.me/BotFather) and:

1. `/newbot` — pick a display name and a username ending in `bot`. Copy the
   token; it goes into `BOT_TOKEN` and never anywhere else.
2. `/setdescription`, `/setabouttext`, `/setuserpic` — what a client sees before
   they press Start.
3. `/setcommands`:
   ```
   start - Записаться или открыть кабинет
   ```
4. **`/setdomain` — do not skip this.** Choose your bot, then send the domain
   from `PUBLIC_URL` (for example `bot.example.com`, without a scheme).

   Without `/setdomain` the Mini App will not open. Telegram refuses to load a
   `web_app` button whose URL is not on the bot's registered domain, and the
   failure is silent: the button appears, the sheet opens empty, and nothing in
   any log says why. If the Mini App shows a blank screen, check this first.

5. `/setinline` — leave it off. This product has no inline mode.

For an alerting bot, repeat `/newbot` and put that token in `ALERT_TG_TOKEN`. It
must be a different bot: the main one being down is precisely when you need the
alarm to work.

---

## 2. DNS and TLS

Point an `A` record at the server:

```
bot.example.com.  300  IN  A  203.0.113.10
```

Wait for it to resolve — `dig +short bot.example.com` — before starting Caddy.
Caddy requests a certificate on first boot, and Let's Encrypt rate-limits
failures.

Nothing else to do: Caddy obtains and renews the certificate itself. That is the
only reason it is in the stack.

---

## 3. Configuration

```bash
git clone <repo> /opt/alnotica && cd /opt/alnotica
cp .env.example .env
```

Generate the two secrets:

```bash
openssl rand -base64 32   # WEBHOOK_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
```

Fill in `.env`. The ones that matter most:

| Variable | Why |
|---|---|
| `BOT_TOKEN`, `BOT_USERNAME` | the shared bot every tenant starts on |
| `WEBHOOK_SECRET` | checked on every webhook request; without it anyone can post fake updates |
| `TOKEN_ENCRYPTION_KEY` | encrypts dedicated bots' tokens at rest. **Losing it makes every dedicated bot unusable** — back it up separately from the database |
| `DOMAIN`, `PUBLIC_URL` | must match what you gave `/setdomain` |
| `ADMIN_TELEGRAM_IDS` | who may run `/admin`. Find yours with [@userinfobot](https://t.me/userinfobot) |

Every variable is parsed with Zod at boot. A missing or malformed one stops the
process immediately with a message naming the field — it will not start and fail
an hour later.

---

## 4. First run

```bash
docker compose build
docker compose up -d db
docker compose run --rm api node packages/db/dist/cli/migrate.js
docker compose up -d
```

The migration runner takes a Postgres advisory lock, so running it from two
places at once is safe.

Check the stack:

```bash
docker compose ps
curl -fsS https://bot.example.com/healthz     # {"ok":true}
docker compose exec api curl -fsS localhost:3000/readyz
```

`/readyz` reports queue depth and unprocessed updates alongside database
reachability; it is deliberately not exposed publicly.

---

## 5. Register the webhook

```bash
docker compose exec api node apps/worker/dist/cli/set-webhook.js
```

It installs the webhook for every active bot and then prints `getWebhookInfo`
back:

```
+ @YourBot: webhook set to https://bot.example.com/tg/8fJ2kQ...
  @YourBot getWebhookInfo:
    url:                    https://bot.example.com/tg/8fJ2kQ...
    has_custom_certificate: false
    pending_update_count:   0
    max_connections:        40
```

**Read that output.** `url` must be your domain and `last_error_message` must be
absent. If it says `SSL error` or `Connection refused`, Telegram cannot reach
you and no update will ever arrive — fix that before going further. Common
causes: DNS has not propagated, port 443 is closed, or Caddy has not finished
getting its certificate (`docker compose logs caddy`).

To check again later, or to go back to long polling:

```bash
docker compose exec api node apps/worker/dist/cli/set-webhook.js --info
docker compose exec api node apps/worker/dist/cli/set-webhook.js --delete
```

---

## 6. The first tenant

Two ways.

**Through the bot** (what a real master does): open `t.me/YourBot`, send
`/start`, and walk the five steps — name, field, time zone, first service,
schedule. The last screen hands you the booking link.

**With demo data** (to see a populated cabinet):

```bash
docker compose exec api node packages/db/dist/cli/seed.js
```

That creates "Груминг у Ани" with four services, two masters, sixty past
appointments including cancellations and no-shows, and twenty upcoming ones —
enough for the statistics screen to be worth looking at. It is idempotent:
running it again replaces the demo tenant rather than duplicating it.

Then open the printed `t.me/YourBot?start=m_demo1234` from a second account and
book something.

---

## 7. Backups

The `backup` service dumps every six hours, gzips, and uploads to S3 when
`S3_BUCKET` is set. Set a 30-day lifecycle rule on the bucket for remote
retention; local retention is `BACKUP_RETENTION_DAYS`.

**Verify the restore. A backup nobody has restored is not a backup.**

```bash
docker compose exec backup bash /app/ops/restore.sh /backups/alnotica-<stamp>.sql.gz
```

With no target database it restores into a scratch database, checks that the
tables and — specifically — both `EXCLUDE` constraints came back, prints row
counts, and drops it again. Run it now, and after any change to the backup
pipeline. Expected output ends with `restore verified`.

To restore for real, into the live database:

```bash
docker compose stop api worker
docker compose exec backup bash /app/ops/restore.sh /backups/<dump>.sql.gz "$DATABASE_URL"
docker compose start api worker
```

---

## 8. Alerting

With `ALERTS_ENABLED=true` the worker checks every five minutes and messages
`ALERT_TG_CHAT` when something is wrong: database unreachable, queue over 500,
more than 10 dead jobs, more than 100 unprocessed updates, the newest processed
update older than 10 minutes, or under 10% disk free. A standing problem is
repeated at most hourly, and recovery is announced once.

Send a test message to confirm the token and chat id are right:

```bash
curl -sS "https://api.telegram.org/bot$ALERT_TG_TOKEN/sendMessage" \
  -d "chat_id=$ALERT_TG_CHAT" -d "text=alert test"
```

---

## 9. Updating

Downtime during a deploy is acceptable, with one condition: **the webhook must
keep answering 200 while migrations run.** Telegram only retries non-200
responses, so a 502 during a migration loses updates permanently.

```bash
git pull
docker compose build
# The API keeps serving — and keeps storing updates — while this runs.
docker compose run --rm api node packages/db/dist/cli/migrate.js
docker compose up -d --no-deps api worker
```

The webhook writes each update to `tg_update` and returns 200 in milliseconds;
the worker drains the backlog once it is back. Restarting the worker mid-flight
is safe: `SIGTERM` stops it claiming new jobs and lets the current batch finish,
and any job whose lock goes stale is reclaimed after five minutes.

---

## 10. Troubleshooting

**The bot does not answer.**
`set-webhook --info` and read `last_error_message`. Then
`docker compose logs -f api | grep tg/`.

**The Mini App opens blank.**
`/setdomain` in BotFather, almost always. Confirm the domain there matches
`PUBLIC_URL` exactly.

**Everything is slow.**
`curl localhost:3000/readyz` for queue depth. A deep queue with a healthy worker
usually means Telegram is rate-limiting: check the worker log for
`job deferred by telegram`.

**"Этот слот только что заняли" on an empty calendar.**
The `appointment_no_overlap` constraint fired. Confirm it survives:
```bash
docker compose exec db psql -U alnotica -d alnotica \
  -c "SELECT conname FROM pg_constraint WHERE contype='x'"
```
Both `appointment_no_overlap` and `time_off_no_overlap` must be listed.

**A master says reminders are not arriving.**
Check whether the client has a Telegram id: a client the master typed in by hand
never pressed `/start`, so the bot may not write to them. The card says so, and
offers an invitation link.
