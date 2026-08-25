/**
 * Replay protection for `POST /book`.
 *
 * A phone on a bad connection retries; a double tap fires twice. Either one must
 * produce one appointment, and the second call must return the same body as the
 * first rather than a conflict.
 *
 * The key is namespaced by tenant and Telegram user, so a client-generated uuid
 * from one person can never collide with another's.
 */
import { idempotency } from '@alnotica/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from './context.js';

export interface IdempotentInput<T> {
  readonly tenantId: string;
  readonly key: string | undefined;
  readonly scope: string;
  run(): Promise<T>;
}

export interface Replayable {
  replayed: boolean;
}

export async function idempotentBooking<T extends Replayable>(
  ctx: AppContext,
  input: IdempotentInput<T>,
): Promise<T> {
  // No key supplied: nothing to deduplicate against, so just run.
  if (!input.key) return input.run();

  const storageKey = `${input.scope}:${input.key}`;

  const [existing] = await ctx.db
    .select()
    .from(idempotency)
    .where(and(eq(idempotency.key, storageKey), eq(idempotency.tenantId, input.tenantId)))
    .limit(1);

  if (existing) {
    return { ...(existing.response as T), replayed: true };
  }

  const result = await input.run();

  await ctx.db
    .insert(idempotency)
    .values({
      key: storageKey,
      tenantId: input.tenantId,
      appointmentId: extractAppointmentId(result),
      response: result as never,
    })
    // Two requests that raced past the SELECT: the loser keeps the winner's row.
    .onConflictDoNothing({ target: idempotency.key });

  return result;
}

function extractAppointmentId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'appointment' in result) {
    const appointment = (result as { appointment?: { id?: unknown } }).appointment;
    if (appointment && typeof appointment.id === 'string') return appointment.id;
  }
  return null;
}
