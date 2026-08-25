import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';

/** postgres.js instance with our explicit bigint codec baked into the type. */
export type Sql = postgres.Sql<{ bigint: bigint }>;
export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  readonly db: Database;
  readonly sql: Sql;
  close(): Promise<void>;
}

export interface DbOptions {
  readonly url: string;
  /** Ten per process is plenty for this workload and keeps us far from max_connections. */
  readonly max?: number;
  readonly onNotice?: (notice: unknown) => void;
  /**
   * Postgres `search_path`. Production leaves this alone; the test harness uses
   * it to give each Vitest worker its own schema.
   */
  readonly searchPath?: string;
}

export function createDb(options: DbOptions): DbHandle {
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    // Pin the bigint codec explicitly. The driver's default is to hand back a
    // string to avoid precision loss; we want a real bigint so that a Telegram id
    // past 2^53 keeps its last digit all the way through the domain.
    types: {
      bigint: postgres.BigInt,
    },
    // Everything in the database is timestamptz; the process runs with TZ=UTC so
    // that an accidental dependency on the system zone fails loudly.
    transform: { undefined: null },
    onnotice: options.onNotice ?? (() => {}),
    prepare: true,
    ...(options.searchPath ? { connection: { search_path: options.searchPath } } : {}),
  });

  // Note: `drizzle()` mutates the client. It replaces postgres.js's date/time
  // serializers and parsers with identity functions so that it can control the
  // representation itself. The practical consequence is that after this line a
  // raw `sql`...${someDate}...`` throws — every hand-written query in this
  // codebase passes ISO strings with an explicit `::timestamptz` cast instead.
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** SQLSTATE codes we react to by name rather than by message text. */
export const PG_ERRORS = {
  /** EXCLUDE constraint violated — someone else took the slot first. */
  exclusionViolation: '23P01',
  /** Unique constraint violated — a replayed update or a duplicate dedupe key. */
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlock: '40P01',
} as const;

interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint_name?: unknown;
}

function asPgError(e: unknown): PgErrorLike | null {
  // Narrowing an unknown thrown value to a bag of optional unknowns: every field
  // is re-checked before use, so this claims no more than it knows.
  return typeof e === 'object' && e !== null ? (e as PgErrorLike) : null;
}

/**
 * Postgres error messages are localized; the SQLSTATE code is not. Every check
 * in this codebase goes through these helpers.
 */
export function pgErrorCode(e: unknown): string | null {
  const code = asPgError(e)?.code;
  return typeof code === 'string' ? code : null;
}

export function isExclusionViolation(e: unknown, constraint?: string): boolean {
  if (pgErrorCode(e) !== PG_ERRORS.exclusionViolation) return false;
  if (!constraint) return true;
  return asPgError(e)?.constraint_name === constraint;
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (pgErrorCode(e) !== PG_ERRORS.uniqueViolation) return false;
  if (!constraint) return true;
  return asPgError(e)?.constraint_name === constraint;
}
