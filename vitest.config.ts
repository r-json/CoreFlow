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
    exclude: ['node_modules', 'e2e', '.next', 'dist'],
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
