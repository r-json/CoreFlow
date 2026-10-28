import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    // Playwright specs live in e2e/ and must not be picked up by vitest.
    //
    // *.integration.test.ts is excluded too: those need a real PostgreSQL database
    // and have their own config (vitest.integration.config.ts). Keeping them out
    // means the unit total can never be mistaken for database validation.
    //
    // packages/, examples/ and apps/ are separate packages with their own
    // dependencies and test runners; each is tested from its own directory.
    exclude: [
      'node_modules',
      'e2e',
      '.next',
      'dist',
      '**/*.integration.test.ts',
      'packages/**',
      'examples/**',
      'apps/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/lib/**', 'src/app/api/**', 'src/hooks/**'],
      exclude: ['**/__tests__/**', '**/*.test.*', 'src/lib/contracts.ts'],
      // Conservative floors that today's suite clears — they exist to catch
      // regressions and should be ratcheted up as coverage grows.
      thresholds: {
        lines: 35,
        functions: 30,
        statements: 35,
        branches: 25,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
