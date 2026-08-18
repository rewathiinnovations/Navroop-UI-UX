/**
 * Tests must never write the repository's own data directory.
 *
 * `getDataDir()` falls back to `<cwd>/.data` outside production, which is the same
 * directory the local dev server reads. A test that wrote `config/observability.json`
 * there once handed the running app a fixture Sentry project id, and `/api/health`
 * correctly reported the file as disagreeing with the CONNECTED Integration row — a
 * real-looking incident produced entirely by a test.
 *
 * Point DATA_DIR at a throwaway directory before any test module loads. A suite that
 * needs its own root still overrides DATA_DIR itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO_DATA_DIR = resolve(process.cwd(), '.data');

function pointsAtRepo(value: string | undefined) {
  if (!value?.trim()) return true;
  return resolve(value) === REPO_DATA_DIR;
}

if (pointsAtRepo(process.env.DATA_DIR)) {
  const root = mkdtempSync(join(tmpdir(), 'navroop-test-data-'));
  process.env.DATA_DIR = root;
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
}
