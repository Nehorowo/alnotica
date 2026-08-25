import type { KeyboardButton } from '@alnotica/core';
/**
 * Inline keyboards.
 *
 * Buttons carry typed callback data through the codec in `packages/shared`, which
 * enforces the 64-byte limit at build time rather than letting Telegram reject the
 * message at send time. One icon per line at most — a wall of emoji reads as spam.
 */
import { type CallbackData, encodeCallback } from '@alnotica/shared';

export type Keyboard = KeyboardButton[][];

export function button(text: string, data: CallbackData): KeyboardButton {
  return { text, data: encodeCallback(data) };
}

export function urlButton(text: string, url: string): KeyboardButton {
  return { text, url };
}

export function webAppButton(text: string, url: string): KeyboardButton {
  return { text, webApp: url };
}

/** Lays buttons out `perRow` at a time; used for slot grids and weekday pickers. */
export function grid(buttons: readonly KeyboardButton[], perRow = 3): Keyboard {
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push([...buttons.slice(i, i + perRow)]);
  }
  return rows;
}

/** Standard pagination footer: eight per page, as the brief asks. */
export const PAGE_SIZE = 8;

export function paginationRow(scope: string, page: number, hasMore: boolean): KeyboardButton[] {
  const row: KeyboardButton[] = [];
  if (page > 0) row.push(button('←', { a: 'page', s: scope, p: page - 1 }));
  if (hasMore) row.push(button('→', { a: 'page', s: scope, p: page + 1 }));
  return row;
}

export function backRow(text: string, target: string): KeyboardButton[] {
  return [button(text, { a: 'menu', v: target })];
}
