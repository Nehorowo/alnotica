/**
 * Moving a tenant onto its own bot.
 *
 * The token is the tenant's entire Telegram presence, so it is encrypted at rest
 * and never leaves this module in plaintext. Two consequences the master has to
 * be told about, because both look like bugs otherwise:
 *
 *  - every stored `file_id` becomes useless, since a file id only works for the
 *    bot that received it. We flag the media for re-upload rather than
 *    downloading and re-uploading the bytes ourselves — storing media is the one
 *    thing this product must never start doing;
 *  - clients have to press /start on the new bot before it may write to them.
 */
import { type BotRow, type Database, botRepo, forTenant, tenantRepo } from '@alnotica/db';
import { NotFoundError, type Plan, assertFeature } from '@alnotica/shared';
import { encryptSecret, generateBotHash } from '../crypto.js';
import type { BotRegistry } from '../telegram/registry.js';

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

export interface AttachDedicatedBotInput {
  readonly db: Database;
  readonly registry: BotRegistry;
  readonly encryptionKey: Buffer;
  readonly tenantId: string;
  /** Straight from BotFather. Never logged, never stored in the clear. */
  readonly token: string;
  readonly publicUrl: string | null;
  readonly webhookSecret: string;
}

export interface AttachDedicatedBotResult {
  readonly bot: BotRow;
  readonly username: string;
  readonly webhookPath: string;
  readonly mediaInvalidated: number;
}

export function looksLikeBotToken(value: string): boolean {
  return TOKEN_RE.test(value.trim());
}

export async function attachDedicatedBot(
  input: AttachDedicatedBotInput,
): Promise<AttachDedicatedBotResult> {
  const tenants = tenantRepo(input.db);
  const bots = botRepo(input.db);

  const tenant = await tenants.byId(input.tenantId);
  if (!tenant) throw new NotFoundError('tenant');
  assertFeature(tenant.plan as Plan, 'dedicated_bot');

  const token = input.token.trim();
  if (!looksLikeBotToken(token)) throw new NotFoundError('bot token');

  // Ask Telegram who this is before storing anything: a wrong token here would
  // otherwise fail much later, on the first outgoing message.
  const probe = input.registry.createBot(token);
  await probe.init();
  const username = probe.botInfo.username;

  const botHash = generateBotHash();
  const bot = await bots.create({
    mode: 'dedicated',
    username,
    botHash,
    tokenEncrypted: encryptSecret(token, input.encryptionKey),
  });

  await tenants.update(tenant.id, { botId: bot.id });

  // Every file_id we hold belonged to the old bot and is now unusable.
  const mediaInvalidated = await forTenant(input.db, tenant.id).media.invalidateForBotChange(
    bot.id,
  );

  // The cached instance for the old bot must not be reused for this tenant.
  input.registry.invalidate(tenant.botId);

  if (input.publicUrl) {
    await probe.api.setWebhook(new URL(`/tg/${botHash}`, input.publicUrl).toString(), {
      secret_token: input.webhookSecret,
      drop_pending_updates: true,
    });
    await bots.markWebhookSet(bot.id);
  }

  return { bot, username, webhookPath: `/tg/${botHash}`, mediaInvalidated };
}

/** Points a bot's webhook at us. Used by the deploy script and by `attach`. */
export async function installWebhook(input: {
  registry: BotRegistry;
  botId: string;
  publicUrl: string;
  webhookSecret: string;
  db: Database;
}): Promise<string> {
  const resolved = await input.registry.byId(input.botId);
  if (!resolved) throw new NotFoundError('bot');

  const url = new URL(`/tg/${resolved.row.botHash}`, input.publicUrl).toString();
  await resolved.bot.api.setWebhook(url, {
    // Without this header check anyone who guesses the path can post fake updates.
    secret_token: input.webhookSecret,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  });
  await botRepo(input.db).markWebhookSet(input.botId);
  return url;
}
