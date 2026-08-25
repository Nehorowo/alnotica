import process from 'node:process';
import { createDb } from '../client.js';
import { migrate } from '../migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const handle = createDb({ url, max: 1 });
try {
  const { applied, skipped } = await migrate(handle.sql);
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already present`);
  for (const name of applied) console.log(`  + ${name}`);
} catch (e) {
  console.error('migration failed:', e);
  process.exitCode = 1;
} finally {
  await handle.close();
}
