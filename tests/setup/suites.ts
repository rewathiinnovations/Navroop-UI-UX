/**
 * Registry of the assert-style suites under `tests/*.test.ts`.
 *
 * Vitest only collects `tests/unit/**` and `tests/integration/**`, so a suite at the
 * root of `tests/` runs only if it is listed here. A file that exists but is absent
 * from both lists looks like coverage and proves nothing —
 * `tests/unit/test-suites-reachable.test.ts` fails when that happens.
 *
 * Paths are resolved by `runLegacySuite`, so they are relative to `tests/setup/`.
 */

/** No database. Loaded by `tests/integration/legacy-suites.test.ts`. */
export const PURE_SUITES = [
  ['pre-migrate', '../../tests/pre-migrate.test.ts'],
  ['sentry-scrub', '../../tests/sentry-scrub.test.ts'],
  ['url-guard', '../../tests/url-guard.test.ts'],
  ['preview-builds', '../../tests/preview-builds.test.ts'],
  ['sandbox-providers', '../../tests/sandbox-providers.test.ts'],
  ['publish-jobs', '../../tests/publish-jobs.test.ts'],
  ['backup', '../../tests/backup.test.ts'],
  ['assets', '../../tests/assets.test.ts'],
  ['checkpoint-storage', '../../tests/checkpoint-storage.test.ts'],
  ['code-audit', '../../tests/code-audit.test.ts'],
  ['export', '../../tests/export.test.ts'],
  ['health', '../../tests/health.test.ts'],
  ['import-pipeline', '../../tests/import-pipeline.test.ts'],
  ['integrations', '../../tests/integrations.test.ts'],
  ['job-chat-ui', '../../tests/job-chat-ui.test.ts'],
  ['logger-scrub', '../../tests/logger-scrub.test.ts'],
  ['memory', '../../tests/memory.test.ts'],
  ['preview-devices', '../../tests/preview-devices.test.ts'],
  ['quality-signals', '../../tests/quality-signals.test.ts'],
  ['seo-audit', '../../tests/seo-audit.test.ts'],
  ['skills', '../../tests/skills.test.ts'],
] as const;

/**
 * Needs TEST_DATABASE_URL. Loaded by `tests/integration/legacy-db-suites.test.ts`,
 * which imports `tests/setup/env.ts` first so DATABASE_URL is rewritten to the test
 * database before any PrismaClient is constructed.
 */
export const DB_SUITES = [
  ['generation-jobs', '../../tests/generation-jobs.test.ts'],
  ['consumption', '../../tests/consumption.test.ts'],
  ['plans-limits', '../../tests/plans-limits.test.ts'],
  ['audit-invariants', '../../tests/audit-invariants.test.ts'],
  ['password-reset', '../../tests/password-reset.test.ts'],
  ['custom-domains', '../../tests/custom-domains.test.ts'],
  ['github-oauth', '../../tests/github-oauth.test.ts'],
  ['legal-terms', '../../tests/legal-terms.test.ts'],
  ['project-lock', '../../tests/project-lock.test.ts'],
  ['search', '../../tests/search.test.ts'],
  ['templates', '../../tests/templates.test.ts'],
] as const;

/** Every registered suite path, as written in the lists above. */
export function registeredSuitePaths() {
  return [...PURE_SUITES, ...DB_SUITES].map(([, path]) => path);
}
