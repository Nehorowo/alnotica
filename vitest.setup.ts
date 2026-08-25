/**
 * Loads `.env.test` into `process.env` before any test runs.
 *
 * The database tests need `TEST_DATABASE_URL`; keeping it in a gitignored file
 * means a developer configures it once instead of exporting it in every shell.
 * CI sets the variable directly and this file finds nothing to do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env.test', import.meta.url));

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
