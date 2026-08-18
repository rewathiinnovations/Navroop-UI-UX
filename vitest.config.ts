import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // `tests/setup/**` is included so the harness guards are themselves tested; a
    // guard nobody exercises is indistinguishable from one that cannot fail.
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/setup/**/*.test.ts',
    ],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    setupFiles: ['tests/setup/vitest.setup.ts'],
    // Runs in its own process, before and after the whole suite: fails the run if a
    // test wrote the repository's own state (.data/, public/uploads, tmp/backups).
    // Those paths are gitignored, so nothing else would notice.
    globalSetup: ['tests/setup/repo-write-guard.global.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/e2b-backends/**', 'lib/**/*.d.ts', 'lib/generation/generation-runtime.ts'],
      // The global floors are a ratchet, not a target: they sit 1–2 points under the
      // measured total for `lib/**` so coverage can only go up. Raise them whenever a
      // run reports more; never lower them to make a change fit. Globs below are
      // stricter floors on individual modules and are also counted in the global
      // numbers. Untested bulk: Coolify/import/sandbox drivers, UI-adjacent lib/,
      // and the excluded generation-runtime stream parser.
      //
      // Measured 2026-08-18 (990/990, exit 0) after the publish live-happy-path
      // tests: 50.70 statements / 71.83 branches / 67.63 functions / 50.70 lines.
      // Functions is still the volatile column (importing a module makes v8
      // enumerate every function in it), so 65 sits ~2.6 under this reading.
      // Statements/lines 49 and branches 70 sit ~1.7–1.8 under. Raise, never lower.
      thresholds: {
        // Recalibrated 2026-08-19 when the sandbox subsystem was removed. That
        // was ~20k lines of heavily tested code, so deleting it lowered the
        // ratio without any test being lost. Measured after: 48.50 lines /
        // statements. Raise, never lower.
        statements: 48,
        branches: 70,
        functions: 65,
        lines: 48,
        'lib/verify/**': { lines: 70, functions: 70, statements: 70, branches: 55 },
        // Re-measured 2026-08-19: the live-sandbox reader and its tests are gone,
        // replaced by tests for the checkpoint/lastCode path and the naming and
        // slug helpers. 50.51 statements / 83.63 branches / 47.76 functions /
        // 50.51 lines. Functions is volatile here — importing one more untested
        // publish module enumerates its functions and moves the number.
        // Raise, never lower.
        'lib/publish/**': { lines: 50, functions: 45, statements: 50, branches: 83 },
        'lib/generation/parse-files.ts': { lines: 80, functions: 80, statements: 80, branches: 70 },
        'lib/secret-scan.ts': { lines: 80, functions: 80, statements: 80, branches: 70 },
        'lib/deploy/release.ts': { lines: 80, functions: 80, statements: 80, branches: 60 },
        'lib/deploy/rollback.ts': { lines: 80, functions: 80, statements: 80, branches: 60 },
      },
    },
  },
});
