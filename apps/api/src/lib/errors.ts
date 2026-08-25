import { AppError, type ErrorResponse, isDomainError } from '@alnotica/shared';
import type { FastifyReply } from 'fastify';

/** Status code for each domain error code. */
const STATUS: Record<string, number> = {
  slot_taken: 409,
  slot_not_available: 409,
  outside_cancel_window: 409,
  invalid_transition: 409,
  too_many_active_appointments: 429,
  rate_limited: 429,
  plan_limit: 402,
  plan_feature: 402,
  broadcast_limit: 422,
  not_found: 404,
};

/**
 * Renders an error for the Mini App.
 *
 * A cross-tenant identifier produces 404, never 403: a 403 would confirm that
 * the row exists and belongs to someone else.
 */
export function sendError(reply: FastifyReply, error: unknown, fallbackStatus = 500): FastifyReply {
  if (isDomainError(error)) {
    const body: ErrorResponse = { error: { code: error.code, message: error.message } };
    return reply.code(STATUS[error.code] ?? 400).send(body);
  }
  if (error instanceof AppError) {
    // Infrastructure errors are never described to the caller in detail.
    return reply
      .code(fallbackStatus)
      .send({ error: { code: 'internal', message: 'internal error' } });
  }
  return reply
    .code(fallbackStatus)
    .send({ error: { code: 'internal', message: 'internal error' } });
}

export function notFound(reply: FastifyReply, entity = 'resource'): FastifyReply {
  const body: ErrorResponse = { error: { code: 'not_found', message: `${entity} not found` } };
  return reply.code(404).send(body);
}
