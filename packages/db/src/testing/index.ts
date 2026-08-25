/**
 * Test harness for the database layer.
 *
 * Two ways of getting a Postgres, chosen automatically:
 *  - `TEST_DATABASE_URL` points at a running server (CI, or a local Postgres);
 *  - otherwise a Testcontainers Postgres is started, if Docker is reachable.
 *
 * Either way the tests run against a real Postgres 16 with `btree_gist`, which is
 * the only way to exercise the EXCLUDE constraint that guards double booking.
 */
import { type DbHandle, createDb } from '../client.js';
import { migrate } from '../migrate.js';

export interface TestDb extends DbHandle {
  /** Empties every application table, keeping the schema. */
  reset(): Promise<void>;
}

let container: { stop: () => Promise<unknown> } | null = null;

async function startContainer(): Promise<string> {
  // Imported lazily so that a machine without Docker (or without the package)
  // can still run the rest of the suite.
  // The specifier is built at runtime so that TypeScript does not require the
  // optional package to be installed for the rest of the suite to type-check.
  const specifier = '@testcontainers/postgresql';
  const mod: unknown = await import(specifier).catch(() => null);
  if (!mod || typeof mod !== 'object' || !('PostgreSqlContainer' in mod)) {
    throw new Error(
      'No TEST_DATABASE_URL and @testcontainers/postgresql is unavailable. ' +
        'Set TEST_DATABASE_URL to a Postgres 16 with btree_gist, or install Docker.',
    );
  }
  const { PostgreSqlContainer } = mod as {
    PostgreSqlContainer: new (
      image: string,
    ) => { start(): Promise<{ getConnectionUri(): string; stop(): Promise<unknown> }> };
  };
  const started = await new PostgreSqlContainer('postgres:16-alpine').start();
  container = started;
  return started.getConnectionUri();
}

const TABLES = [
  'reminder_log',
  'idempotency',
  'job',
  'session',
  'tg_update',
  'broadcast',
  'appointment',
  'client',
  'time_off',
  'working_hours',
  'staff_service',
  'service',
  'staff',
  'media',
  'tenant',
  'bot',
];

/** Opens a migrated database for one test file. */
export async function openTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL ?? (await startContainer());
  const handle = createDb({ url, max: 5 });
  await migrate(handle.sql);

  return {
    ...handle,
    async reset() {
      await handle.sql.unsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await handle.close();
      if (container) {
        await container.stop();
        container = null;
      }
    },
  };
}

/** True when a database is reachable, so a suite can skip instead of failing. */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}
