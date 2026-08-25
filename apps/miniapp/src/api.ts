/**
 * API client.
 *
 * Responses are validated with the same Zod schemas the server uses to build
 * them, so a deployment skew shows up as a clear error rather than as an
 * `undefined` three renders later.
 */
import {
  type AvailabilityResponse,
  type BookRequest,
  type BookResponse,
  IDEMPOTENCY_HEADER,
  INIT_DATA_HEADER,
  type ScheduleResponse,
  availabilityResponseSchema,
  bookResponseSchema,
  errorResponseSchema,
  scheduleResponseSchema,
  serviceDtoSchema,
  staffDtoSchema,
} from '@alnotica/shared';
import { z } from 'zod';
import { initData } from './telegram.js';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly alternatives: AvailabilityResponse['days'][number]['slots'] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const servicesResponseSchema = z.object({
  tenant: z.object({ title: z.string(), timezone: z.string(), address: z.string().nullable() }),
  services: z.array(serviceDtoSchema),
  staff: z.array(staffDtoSchema),
});
export type ServicesResponse = z.infer<typeof servicesResponseSchema>;

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { [INIT_DATA_HEADER]: initData() };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('bad_response', 'Сервер ответил неожиданным образом', response.status);
  }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    if (parsed.success) {
      throw new ApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.error.alternatives ?? [],
      );
    }
    throw new ApiError('http_error', `Ошибка ${response.status}`, response.status);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('bad_response', 'Ответ сервера не совпадает с ожидаемым', response.status);
  }
  return parsed.data;
}

export function getServices(slug: string): Promise<ServicesResponse> {
  return request(`/api/miniapp/${slug}/services`, servicesResponseSchema);
}

export function getAvailability(
  slug: string,
  query: { serviceId: string; staffId: string; from: string; to: string },
): Promise<AvailabilityResponse> {
  const params = new URLSearchParams(query);
  return request(
    `/api/miniapp/${slug}/availability?${params.toString()}`,
    availabilityResponseSchema,
  );
}

export function book(
  slug: string,
  body: BookRequest,
  idempotencyKey: string,
): Promise<BookResponse> {
  return request(`/api/miniapp/${slug}/book`, bookResponseSchema, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export function getSchedule(slug: string, from: string, to: string): Promise<ScheduleResponse> {
  const params = new URLSearchParams({ from, to });
  return request(`/api/miniapp/${slug}/schedule?${params.toString()}`, scheduleResponseSchema);
}
