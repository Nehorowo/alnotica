import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client.js';

/**
 * Plain-SQL migration runner.
 *
 * Files are applied in filename order inside one transaction each, guarded by a
 * session-level advisory lock so that two processes starting at the same moment
 * (api and worker both boot on deploy) cannot race.
 */
const LOCK_ID = 726_351_991;

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await sql`SELECT pg_advisory_lock(${LOCK_ID})`;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = await sql<{ name: string }[]>`SELECT name FROM schema_migration`;
    const alreadyApplied = new Set(done.map((r) => r.name));

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (alreadyApplied.has(file)) {
        skipped.push(file);
        continue;
      }
      const body = await readFile(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migration (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
  }
}

/** Drops everything this application owns. Used by the test harness only. */
export async function dropAll(sql: Sql): Promise<void> {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
