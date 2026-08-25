/**
 * Deep-link payloads.
 *
 * Telegram allows at most 64 characters from [A-Za-z0-9_-] after `?start=`.
 * No dots, no colons, no Cyrillic — anything else silently breaks the link.
 */
import { NotFoundError } from '../errors.js';

export const MAX_PAYLOAD_LENGTH = 64;
const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type StartPayload =
  /** `m_<slug>` — landed on a master's page. */
  | { readonly kind: 'master'; readonly slug: string }
  /** `s_<slug>_<serviceIdx>` — straight to one service, skipping the picker. */
  | { readonly kind: 'service'; readonly slug: string; readonly serviceIdx: number }
  /** `r_<ref>` — arrived from a reminder or an invitation for a specific appointment. */
  | { readonly kind: 'ref'; readonly ref: string };

export function isValidPayload(payload: string): boolean {
  return PAYLOAD_RE.test(payload);
}

export function encodeStartPayload(payload: StartPayload): string {
  const encoded = encodeUnchecked(payload);
  if (!isValidPayload(encoded)) {
    throw new RangeError(`deep-link payload "${encoded}" is not acceptable to Telegram`);
  }
  return encoded;
}

function encodeUnchecked(payload: StartPayload): string {
  switch (payload.kind) {
    case 'master':
      return `m_${payload.slug}`;
    case 'service':
      return `s_${payload.slug}_${payload.serviceIdx}`;
    case 'ref':
      return `r_${payload.ref}`;
  }
}

/** Parses a `/start` payload; returns null for anything we do not recognise. */
export function parseStartPayload(raw: string | undefined | null): StartPayload | null {
  if (!raw || !isValidPayload(raw)) return null;
  const sep = raw.indexOf('_');
  if (sep < 0) return null;
  const prefix = raw.slice(0, sep);
  const rest = raw.slice(sep + 1);
  if (rest.length === 0) return null;

  switch (prefix) {
    case 'm':
      return { kind: 'master', slug: rest };
    case 's': {
      const lastSep = rest.lastIndexOf('_');
      if (lastSep <= 0) return null;
      const slug = rest.slice(0, lastSep);
      const idxRaw = rest.slice(lastSep + 1);
      if (!/^\d{1,4}$/.test(idxRaw)) return null;
      return { kind: 'service', slug, serviceIdx: Number(idxRaw) };
    }
    case 'r':
      return { kind: 'ref', ref: rest };
    default:
      return null;
  }
}

export function startLink(botUsername: string, payload: StartPayload): string {
  const username = botUsername.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{4,32}$/.test(username)) throw new NotFoundError('bot username');
  return `https://t.me/${username}?start=${encodeStartPayload(payload)}`;
}
