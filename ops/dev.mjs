/**
 * `pnpm dev` — one command for the whole stack.
 *
 * Builds the workspace once, then runs the API, the worker and the Mini App's
 * Vite server together, prefixing their output. Ctrl-C stops all three.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const COLORS = { api: '\x1b[36m', worker: '\x1b[35m', miniapp: '\x1b[32m', build: '\x1b[33m' };
const RESET = '\x1b[0m';

function run(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const prefix = `${COLORS[name] ?? ''}[${name}]${RESET} `;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') process.stdout.write(`${prefix}${line}\n`);
      }
    });
  }
  return child;
}

function once(name, command, args) {
  return new Promise((resolve, reject) => {
    const child = run(name, command, args);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`)),
    );
  });
}

const children = [];
function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  // Migrations first: the two processes both assume the schema is current, and
  // the runner takes an advisory lock so running it twice is harmless.
  await once('build', 'pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@alnotica/db',
    '--filter=@alnotica/shared',
    '--filter=@alnotica/core',
  ]);
  await once('build', 'node', ['packages/db/dist/cli/migrate.js']);
  await once('build', 'pnpm', ['exec', 'turbo', 'run', 'build']);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

children.push(run('api', 'node', ['apps/api/dist/main.js']));
children.push(run('worker', 'node', ['apps/worker/dist/main.js']));
children.push(run('miniapp', 'pnpm', ['--filter', '@alnotica/miniapp', 'dev']));

for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`a process exited with ${code}; stopping the rest`);
      shutdown();
    }
  });
}
