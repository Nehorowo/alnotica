/**
 * The admin surface: the moderation queue for first-time broadcasters, dead jobs,
 * and a health summary. Access is by Telegram id from the environment — there are
 * no roles to configure and nothing to misconfigure.
 */
import {
  approveBroadcast,
  attachDedicatedBot,
  looksLikeBotToken,
  parseEncryptionKey,
  rejectBroadcast,
} from '@alnotica/core';
import { jobRepo } from '@alnotica/db';
import { decodeCallback, esc, html } from '@alnotica/shared';
import type { Composer } from 'grammy';
import type { BotContext } from './context.js';
import { type Keyboard, button } from './keyboards.js';
import { renderMenu } from './menu.js';
import { currentStaff } from './staff-flow.js';
import { texts } from './texts.js';

function isAdmin(ctx: BotContext): boolean {
  const id = ctx.from?.id;
  if (id === undefined) return false;
  return ctx.deps.env.ADMIN_TELEGRAM_IDS.includes(BigInt(id));
}

export function registerAdminFlow(composer: Composer<BotContext>): void {
  composer.command('admin', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    await showAdminHome(ctx);
  });

  composer.on('callback_query:data', async (ctx, next) => {
    const data = decodeCallback(ctx.callbackQuery.data);
    if (!data) return next();

    /* The master pastes a token from BotFather. */
    if (data.a === 'set' && data.k === 'ownbot') {
      const membership = await currentStaff(ctx);
      if (!membership) return next();
      ctx.session.awaiting = { kind: 'client_search', context: 'ownbot' };
      await ctx.answerCallbackQuery();
      await ctx.reply(
        'Пришлите токен бота из BotFather. Мы зашифруем его и переключим запись на ваш бот.\n' +
          'Учтите: сохранённые фото придётся загрузить заново, а клиентам нужно будет нажать /start в новом боте.',
      );
      return;
    }

    if (!isAdmin(ctx)) return next();

    if (data.a === 'bc_mod') {
      const found = await ctx.tenants.byBroadcastId(data.id);
      if (!found) {
        await ctx.answerCallbackQuery({ text: texts.errors.notFound, show_alert: true });
        return;
      }
      const moderator = BigInt(ctx.from?.id ?? 0);
      const deps = { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() };

      if (data.o === 'approve') {
        await approveBroadcast(deps, found.tenant, data.id, moderator);
        await ctx.answerCallbackQuery({ text: texts.broadcast.approved });
      } else {
        await rejectBroadcast(deps, found.tenant, data.id, moderator);
        await ctx.answerCallbackQuery({ text: texts.broadcast.rejected });
      }
      return showAdminHome(ctx);
    }

    if (data.a === 'menu' && data.v === 'admin') {
      await ctx.answerCallbackQuery();
      return showAdminHome(ctx);
    }

    return next();
  });

  /* The token arrives as plain text; it must never be echoed or logged. */
  composer.on('message:text', async (ctx, next) => {
    if (
      ctx.session.awaiting?.kind !== 'client_search' ||
      ctx.session.awaiting.context !== 'ownbot'
    ) {
      return next();
    }
    const membership = await currentStaff(ctx);
    if (!membership) return next();

    const token = ctx.message.text.trim();
    ctx.session.awaiting = undefined;
    // Delete the message carrying the token as soon as we have it.
    await ctx.deleteMessage().catch(() => {});

    if (!looksLikeBotToken(token)) {
      await ctx.reply('Это не похоже на токен бота. Скопируйте его целиком из BotFather.');
      return;
    }

    try {
      const result = await attachDedicatedBot({
        db: ctx.deps.db,
        registry: ctx.deps.registry,
        encryptionKey: parseEncryptionKey(ctx.deps.env.TOKEN_ENCRYPTION_KEY),
        tenantId: membership.tenant.id,
        token,
        publicUrl: ctx.deps.env.PUBLIC_URL ?? null,
        webhookSecret: ctx.deps.env.WEBHOOK_SECRET,
      });
      await ctx.reply(
        html`Готово: запись теперь идёт через @${result.username}.${
          result.mediaInvalidated > 0
            ? ` Загрузите заново фото (${result.mediaInvalidated}) — старые ссылки не работают в новом боте.`
            : ''
        }`.value,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      ctx.deps.log.error(
        { err: error, tenantId: membership.tenant.id },
        'attaching a dedicated bot failed',
      );
      await ctx.reply(texts.errors.planFeature);
    }
  });
}

async function showAdminHome(ctx: BotContext): Promise<void> {
  const tenants = await ctx.tenants.listActive();
  const rows: Keyboard = [];
  const lines = ['<b>Админка</b>'];

  let pending = 0;
  for (const tenant of tenants) {
    const repo = ctx.tenantRepo(tenant.id);
    for (const broadcast of await repo.broadcasts.list(5)) {
      if (broadcast.status !== 'pending_moderation') continue;
      pending++;
      lines.push(html`${tenant.title}: ${broadcast.text.slice(0, 80)}`.value);
      rows.push([
        button('Одобрить', { a: 'bc_mod', o: 'approve', id: broadcast.id }),
        button('Отклонить', { a: 'bc_mod', o: 'reject', id: broadcast.id }),
      ]);
    }
  }
  if (pending === 0) lines.push('Рассылок на модерации нет.');

  const dead = await jobRepo(ctx.deps.db).dead(10);
  lines.push('', esc(`Мёртвых задач: ${dead.length}`));
  for (const job of dead.slice(0, 5)) {
    lines.push(html`${job.kind}: ${job.lastError?.slice(0, 80) ?? ''}`.value);
  }

  lines.push('', esc(`Арендаторов: ${tenants.length}`));
  rows.push([button('Обновить', { a: 'menu', v: 'admin' })]);

  await renderMenu(ctx, { text: lines.join('\n'), keyboard: rows, fresh: true });
}
