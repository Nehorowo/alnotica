/**
 * API client.
 *
 * Responses are validated with the same Zod schemas the server uses to build
 * them, so a deployment skew shows up as a clear error rather than as an
 * `undefined` three renders later.
 */
import type {
  AvailabilityResponse,
  BookRequest,
  BookResponse,
  ScheduleResponse,
} from '@alnotica/shared';
import type { z } from 'zod';
export declare class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly alternatives: AvailabilityResponse['days'][number]['slots'];
  constructor(
    code: string,
    message: string,
    status: number,
    alternatives?: AvailabilityResponse['days'][number]['slots'],
  );
}
declare const servicesResponseSchema: z.ZodObject<
  {
    tenant: z.ZodObject<
      {
        title: z.ZodString;
        timezone: z.ZodString;
        address: z.ZodNullable<z.ZodString>;
      },
      'strip',
      z.ZodTypeAny,
      {
        title: string;
        timezone: string;
        address: string | null;
      },
      {
        title: string;
        timezone: string;
        address: string | null;
      }
    >;
    services: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          name: z.ZodString;
          description: z.ZodNullable<z.ZodString>;
          durationMin: z.ZodNumber;
          bufferAfterMin: z.ZodNumber;
          priceMinor: z.ZodNullable<z.ZodNumber>;
          currency: z.ZodString;
        },
        'strip',
        z.ZodTypeAny,
        {
          id: string;
          name: string;
          description: string | null;
          durationMin: number;
          bufferAfterMin: number;
          priceMinor: number | null;
          currency: string;
        },
        {
          id: string;
          name: string;
          description: string | null;
          durationMin: number;
          bufferAfterMin: number;
          priceMinor: number | null;
          currency: string;
        }
      >,
      'many'
    >;
    staff: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          name: z.ZodString;
        },
        'strip',
        z.ZodTypeAny,
        {
          id: string;
          name: string;
        },
        {
          id: string;
          name: string;
        }
      >,
      'many'
    >;
  },
  'strip',
  z.ZodTypeAny,
  {
    tenant: {
      title: string;
      timezone: string;
      address: string | null;
    };
    services: {
      id: string;
      name: string;
      description: string | null;
      durationMin: number;
      bufferAfterMin: number;
      priceMinor: number | null;
      currency: string;
    }[];
    staff: {
      id: string;
      name: string;
    }[];
  },
  {
    tenant: {
      title: string;
      timezone: string;
      address: string | null;
    };
    services: {
      id: string;
      name: string;
      description: string | null;
      durationMin: number;
      bufferAfterMin: number;
      priceMinor: number | null;
      currency: string;
    }[];
    staff: {
      id: string;
      name: string;
    }[];
  }
>;
export type ServicesResponse = z.infer<typeof servicesResponseSchema>;
export declare function getServices(slug: string): Promise<ServicesResponse>;
export declare function getAvailability(
  slug: string,
  query: {
    serviceId: string;
    staffId: string;
    from: string;
    to: string;
  },
): Promise<AvailabilityResponse>;
export declare function book(
  slug: string,
  body: BookRequest,
  idempotencyKey: string,
): Promise<BookResponse>;
export declare function getSchedule(
  slug: string,
  from: string,
  to: string,
): Promise<ScheduleResponse>;
//# sourceMappingURL=api.d.ts.map
