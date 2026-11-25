import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The Workbench reads the shared test vectors and the recorded Testnet evidence
// straight from the repository, so there is one copy of each.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // Relative asset paths: the build works from any folder or static file host.
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@repo': repoRoot },
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
  // @coreflow/sdk is linked from packages/sdk, so Vite must pre-bundle it
  // (and its CommonJS dependency @stellar/stellar-base) explicitly.
  optimizeDeps: { include: ['@coreflow/sdk'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The vendor chunk is React plus @stellar/stellar-base's browser bundle
    // (about 680 kB, 190 kB gzipped). Every page needs both, so splitting
    // further would not reduce what a visitor downloads.
    chunkSizeWarningLimit: 720,
    rollupOptions: {
      output: {
        // Third-party code changes rarely; a separate chunk caches well.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
  test: {
    // happy-dom shares Node's typed arrays. Under jsdom, @noble/curves (inside
    // @stellar/stellar-base) rejects the test's Uint8Arrays as foreign objects.
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
