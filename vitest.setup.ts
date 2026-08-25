/**
 * Loads `.env.test` into `process.env` before any test runs.
 *
 * The database tests need `TEST_DATABASE_URL`; keeping it in a gitignored file
 * means a developer configures it once instead of exporting it in every shell.
 * CI sets the variable directly and this file finds nothing to do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment the
// module URL is an http one and cannot be converted to a path.
const envFile = join(process.cwd(), '.env.test');

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    process.env[key] ??= value;
  }
}

// Scheduling arithmetic must never depend on the machine's zone.
process.env.TZ = 'UTC';
