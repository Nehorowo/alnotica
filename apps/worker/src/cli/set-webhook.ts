/**
 * Points every active bot's webhook at this deployment, then reads back
 * `getWebhookInfo` so the operator sees what Telegram actually recorded rather
 * than what we hoped it would.
 *
 *   pnpm set-webhook           install
 *   pnpm set-webhook --delete  remove (switch back to long polling)
 *   pnpm set-webhook --info    report only
 */
import process from 'node:process';
import { BotRegistry, createLogger, env, parseEncryptionKey } from '@alnotica/core';
import { botRepo, createDb } from '@alnotica/db';

const config = env();
const log = createLogger({ level: 'info', name: 'set-webhook' });

const mode = process.argv.includes('--delete')
  ? 'delete'
  : process.argv.includes('--info')
    ? 'info'
    : 'install';

if (mode === 'install' && !config.PUBLIC_URL) {
  console.error('PUBLIC_URL is required to install a webhook');
  process.exit(1);
}

const handle = createDb({ url: config.DATABASE_URL, max: 2 });
const registry = new BotRegistry({
  db: handle.db,
  log,
  sharedBotToken: config.BOT_TOKEN,
  encryptionKey: parseEncryptionKey(config.TOKEN_ENCRYPTION_KEY),
});

try {
  const bots = botRepo(handle.db);
  const rows = await bots.listActive();
  if (rows.length === 0) console.log('no active bots; create a tenant first');

  for (const row of rows) {
    const resolved = await registry.byId(row.id);
    if (!resolved) {
      console.log(`- @${row.username}: could not be initialised, skipping`);
      continue;
    }

    if (mode === 'install') {
      const url = new URL(`/tg/${row.botHash}`, config.PUBLIC_URL ?? '').toString();
      await resolved.bot.api.setWebhook(url, {
        // Telegram echoes this back in X-Telegram-Bot-Api-Secret-Token; without
        // it anyone who guesses the path can post updates as Telegram.
        secret_token: config.WEBHOOK_SECRET,
        drop_pending_updates: false,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        max_connections: 40,
      });
      await bots.markWebhookSet(row.id);
      // The path is printed; the token never is.
      console.log(`+ @${row.username}: webhook set to ${url}`);
    } else if (mode === 'delete') {
      await resolved.bot.api.deleteWebhook({ drop_pending_updates: false });
      console.log(`- @${row.username}: webhook removed`);
    }

    const info = await resolved.bot.api.getWebhookInfo();
    console.log(`  @${row.username} getWebhookInfo:`);
    console.log(`    url:                    ${info.url || '(none)'}`);
    console.log(`    has_custom_certificate: ${info.has_custom_certificate}`);
    console.log(`    pending_update_count:   ${info.pending_update_count}`);
    if (info.last_error_message) {
      // This is the field that explains a bot that "does not work": a bad
      // certificate or an unreachable host shows up here and nowhere else.
      console.log(
        `    last_error_date:        ${new Date((info.last_error_date ?? 0) * 1000).toISOString()}`,
      );
      console.log(`    last_error_message:     ${info.last_error_message}`);
    }
    if (info.max_connections) console.log(`    max_connections:        ${info.max_connections}`);
  }
} catch (e) {
  console.error('set-webhook failed:', e);
  process.exitCode = 1;
} finally {
  await handle.close();
}
