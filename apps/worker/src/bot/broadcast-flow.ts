/**
 * The broadcast screens and the "a window opened" offer.
 *
 * Every limit lives in `packages/core`; this file only turns a rejection into a
 * sentence the master can act on.
 */
import { createBroadcast, offerFreedWindow, resolveAudience } from '@alnotica/core';
import type { TenantRow } from '@alnotica/db';
import {
  type AudienceFilter,
  BroadcastLimitError,
  MAX_BROADCASTS_PER_MONTH,
  MIN_HOURS_BETWEEN_BROADCASTS,
  MIN_TENANT_AGE_DAYS,
  PlanFeatureError,
  WINDOW_OPENED_INACTIVE_DAYS,
  assertNever,
  decodeCallback,
  esc,
  html,
} from '@alnotica/shared';
import type { Composer } from 'grammy';
import type { BotContext } from './context.js';
import { formatWhen } from './format.js';
import { type Keyboard, button } from './keyboards.js';
import { renderMenu } from './menu.js';
import { currentStaff } from './staff-flow.js';
import { texts } from './texts.js';

/** Turns a limit rejection into the specific reason, never a generic failure. */
export function explainLimit(error: BroadcastLimitError): string {
  switch (error.reason) {
    case 'monthly_quota':
      return texts.broadcast.limitMonthly(MAX_BROADCASTS_PER_MONTH);
    case 'cooldown':
      return texts.broadcast.limitCooldown(MIN_HOURS_BETWEEN_BROADCASTS);
    case 'tenant_too_young':
      return texts.broadcast.limitTooYoung(MIN_TENANT_AGE_DAYS);
    case 'empty_audience':
      return texts.broadcast.limitEmpty;
    default:
      return assertNever(error.reason, 'broadcast rejection');
  }
}

const AUDIENCES: readonly { label: string; filter: AudienceFilter }[] = [
  { label: texts.broadcast.audienceAll, filter: { kind: 'all' } },
  { label: texts.broadcast.audienceRecent(30), filter: { kind: 'visited_within', days: 30 } },
  { label: texts.broadcast.audienceDormant(60), filter: { kind: 'not_visited_for', days: 60 } },
];

async function showBroadcastHome(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const repo = ctx.tenantRepo(tenant.id);
  const recent = await repo.broadcasts.list(5);

  const lines = [`<b>${esc(texts.broadcast.title)}</b>`];
  for (const b of recent) {
    lines.push(html`${b.status} · ${b.sent}/${b.total}`.value);
  }

  const rows: Keyboard = [
    [button(texts.staff.menuBroadcast, { a: 'bc', o: 'new' })],
    [button(texts.common.back, { a: 'menu', v: 'cabinet' })],
  ];
  await renderMenu(ctx, { text: lines.join('\n'), keyboard: rows });
}

async function showAudiencePicker(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const rows: Keyboard = [];
  for (const [index, option] of AUDIENCES.entries()) {
    const size = (
      await resolveAudience(
        { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
        tenant,
        option.filter,
      )
    ).length;
    rows.push([button(`${option.label} · ${size}`, { a: 'set', k: 'bc_aud', v: String(index) })]);
  }
  rows.push([button(texts.common.back, { a: 'menu', v: 'bc' })]);
  await renderMenu(ctx, { text: texts.broadcast.title, keyboard: rows });
}

export function registerBroadcastFlow(composer: Composer<BotContext>): void {
  composer.on('message:text', async (ctx, next) => {
    if (ctx.session.awaiting?.kind !== 'broadcast_text') return next();
    const membership = await currentStaff(ctx);
    if (!membership) return next();

    const index = Number(ctx.session.awaiting.context ?? '0');
    const option = AUDIENCES[index] ?? AUDIENCES[0];
    if (!option) return next();
    ctx.session.awaiting = undefined;

    try {
      const { moderated, audienceSize } = await createBroadcast(
        { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
        {
          tenant: membership.tenant,
          // Escaped once, here, because the text goes out with parse_mode HTML.
          text: esc(ctx.message.text.slice(0, 3000)),
          mediaId: null,
          audience: option.filter,
        },
      );
      await renderMenu(ctx, {
        text: moderated
          ? esc(texts.broadcast.onModeration)
          : esc(`${texts.common.done} · ${audienceSize}`),
        keyboard: [[button(texts.common.back, { a: 'menu', v: 'cabinet' })]],
        fresh: true,
      });
      if (moderated) await notifyModerators(ctx, membership.tenant);
    } catch (error) {
      if (error instanceof BroadcastLimitError) {
        await ctx.reply(explainLimit(error));
        return;
      }
      if (error instanceof PlanFeatureError) {
        await ctx.reply(texts.errors.planFeature);
        return;
      }
      throw error;
    }
  });

  composer.on('callback_query:data', async (ctx, next) => {
    const data = decodeCallback(ctx.callbackQuery.data);
    if (!data) return next();

    /* Unsubscribing is available to any client, not only to staff. */
    if (data.a === 'unsub') {
      const tenant = await ctx.tenants.byId(data.t);
      if (!tenant) return next();
      const telegramId = ctx.from?.id;
      if (telegramId === undefined) return next();
      const client = await ctx.tenantRepo(tenant.id).clients.byTelegramId(BigInt(telegramId));
      if (client) await ctx.tenantRepo(tenant.id).clients.optOut(client.id);
      // Transactional reminders keep coming: those are about their own booking.
      await ctx.answerCallbackQuery({ text: texts.broadcast.unsubscribed, show_alert: true });
      return;
    }

    const membership = await currentStaff(ctx);
    if (!membership) return next();
    const { tenant } = membership;

    if (data.a === 'menu' && data.v === 'bc') {
      await ctx.answerCallbackQuery();
      return showBroadcastHome(ctx, tenant);
    }

    if (data.a === 'bc') {
      switch (data.o) {
        case 'new':
          await ctx.answerCallbackQuery();
          return showAudiencePicker(ctx, tenant);
        case 'window': {
          if (!data.id) return next();
          await ctx.answerCallbackQuery();
          return offerWindow(ctx, tenant, data.id);
        }
        default:
          return next();
      }
    }

    if (data.a === 'set' && data.k === 'bc_aud') {
      ctx.session.awaiting = { kind: 'broadcast_text', context: data.v ?? '0' };
      await ctx.answerCallbackQuery();
      await ctx.reply(texts.broadcast.title);
      return;
    }

    return next();
  });
}

/** One tap on the cancellation notice offers the freed slot to lapsed clients. */
async function offerWindow(
  ctx: BotContext,
  tenant: TenantRow,
  appointmentId: string,
): Promise<void> {
  try {
    const { audienceSize, moderated } = await offerFreedWindow(
      { db: ctx.deps.db, queue: ctx.deps.queue, nowMs: ctx.now() },
      { tenant, appointmentId },
      ({ serviceName, when }) => esc(texts.broadcast.windowOpenedOffer(serviceName, when)),
      formatWhen,
    );
    await renderMenu(ctx, {
      text: moderated
        ? esc(texts.broadcast.onModeration)
        : esc(`${texts.broadcast.windowOpened} · ${audienceSize}`),
      fresh: true,
    });
  } catch (error) {
    if (error instanceof BroadcastLimitError) {
      await ctx.reply(explainLimit(error));
      return;
    }
    if (error instanceof PlanFeatureError) {
      await ctx.reply(texts.errors.planFeature);
      return;
    }
    throw error;
  }
}

async function notifyModerators(ctx: BotContext, tenant: TenantRow): Promise<void> {
  const adminChat = ctx.deps.env.ADMIN_CHAT_ID;
  if (!adminChat) return;
  await ctx.deps.queue.enqueue({
    kind: 'send_message',
    payload: {
      kind: 'send_message',
      botId: ctx.deps.botRow.id,
      chatId: adminChat,
      text: html`Рассылка на модерации: ${tenant.title} (${tenant.slug})`.value,
      disablePreview: true,
      marketing: false,
      tenantId: tenant.id,
    },
    priority: 10,
  });
}

export { WINDOW_OPENED_INACTIVE_DAYS };
