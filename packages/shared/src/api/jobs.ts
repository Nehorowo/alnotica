/**
 * Job payloads. A row in `job` is untrusted data — it may have been written by an
 * older deployment — so every payload is parsed with Zod on the way out of the
 * queue, not merely cast.
 */
import { z } from 'zod';
import { uuidSchema } from '../schemas/common.js';

export const JOB_KINDS = [
  'process_update',
  'send_message',
  'reminder',
  'broadcast_chunk',
  'ask_no_show',
  'daily_digest',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Lower number = more urgent. Transactional traffic must never queue behind a blast. */
export const PRIORITY = {
  update: 5,
  transactional: 10,
  reminder: 20,
  digest: 100,
  broadcast: 900,
} as const;

const chatTarget = z.object({
  botId: uuidSchema,
  chatId: z.string().regex(/^-?\d+$/),
});

export const sendMessagePayloadSchema = chatTarget.extend({
  kind: z.literal('send_message'),
  text: z.string().min(1).max(4096),
  /** Pre-encoded inline keyboard; already validated when it was built. */
  keyboard: z
    .array(
      z.array(
        z.object({
          text: z.string(),
          data: z.string().optional(),
          url: z.string().optional(),
          webApp: z.string().optional(),
        }),
      ),
    )
    .optional(),
  /** Edit this message instead of sending a new one, when it still exists. */
  editMessageId: z.number().int().optional(),
  disablePreview: z.boolean().default(true),
  /** Marks the message as part of a marketing send, for opt-out bookkeeping. */
  marketing: z.boolean().default(false),
  tenantId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
});

export const processUpdatePayloadSchema = z.object({
  kind: z.literal('process_update'),
  botId: uuidSchema,
  tgUpdateRowId: z.string().regex(/^\d+$/),
});

export const reminderPayloadSchema = z.object({
  kind: z.literal('reminder'),
  appointmentId: uuidSchema,
  offsetMin: z.number().int().positive(),
});

export const askNoShowPayloadSchema = z.object({
  kind: z.literal('ask_no_show'),
  appointmentId: uuidSchema,
});

export const dailyDigestPayloadSchema = z.object({
  kind: z.literal('daily_digest'),
  tenantId: uuidSchema,
  /** Local date the digest is about (tomorrow, from the tenant's point of view). */
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const broadcastChunkPayloadSchema = z.object({
  kind: z.literal('broadcast_chunk'),
  broadcastId: uuidSchema,
  clientIds: z.array(uuidSchema).min(1).max(500),
  chunkIndex: z.number().int().min(0),
});

export const jobPayloadSchema = z.discriminatedUnion('kind', [
  processUpdatePayloadSchema,
  sendMessagePayloadSchema,
  reminderPayloadSchema,
  askNoShowPayloadSchema,
  dailyDigestPayloadSchema,
  broadcastChunkPayloadSchema,
]);

export type JobPayload = z.infer<typeof jobPayloadSchema>;
export type SendMessagePayload = z.infer<typeof sendMessagePayloadSchema>;
export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;
export type BroadcastChunkPayload = z.infer<typeof broadcastChunkPayloadSchema>;
export type DailyDigestPayload = z.infer<typeof dailyDigestPayloadSchema>;
export type AskNoShowPayload = z.infer<typeof askNoShowPayloadSchema>;
export type ProcessUpdatePayload = z.infer<typeof processUpdatePayloadSchema>;

export const MAX_ATTEMPTS = 5;
/** Exponential backoff of 2^attempts minutes, capped at six hours. */
export const BACKOFF_CAP_MS = 6 * 3_600_000;

export function backoffMs(attempts: number): number {
  const minutes = 2 ** Math.max(0, Math.min(attempts, 20));
  return Math.min(minutes * 60_000, BACKOFF_CAP_MS);
}
