import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * INTEGRATION tests: these talk to a real PostgreSQL database.
 *
 * Deliberately a separate config from the unit suite, for two reasons:
 *
 * 1. The counts must not merge. "761 passing" meaning nothing about the database
 *    is exactly the false confidence this gate exists to remove, so unit and
 *    integration totals are reported separately and cannot be conflated.
 *
 * 2. They share one database. Tests truncate tables between cases, so they must
 *    run in a single process, one file at a time — parallel files would reset each
 *    other's fixtures and fail in ways that look like product bugs.
 *
 * Requires a LOCAL database (see docs/ENVIRONMENTS.md). scripts/check-env.mjs
 * refuses a non-local DATABASE_URL, and `npm run test:integration` runs it first.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'e2e', '.next', 'dist'],
    // One database, one worker, one file at a time.
    fileParallelism: false,
    pool: 'forks',
    // Vitest 4 moved these to the top level.
    maxWorkers: 1,
    minWorkers: 1,
    // Real connections and real DDL are slower than an in-memory double.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
