import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/miniapp/',
  resolve: {
    alias: {
      // The slot engine and every response schema come straight from the shared
      // package, so the calendar the client sees is drawn by the same code that
      // validates the booking on the server.
      '@alnotica/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
