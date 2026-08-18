import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_DATA_DIR } from '../setup/data-dir-guard';
import { getDataDir } from '../../lib/runtime/data-dir';
import { runtimeConfigPath, writeRuntimeConfig } from '../../lib/observability/runtime-config';

/**
 * The repository's `.data` directory is what the local dev server reads. A test that
 * wrote `config/observability.json` there handed the running app a fixture Sentry project
 * id, and `/api/health` reported the file as disagreeing with the CONNECTED Integration
 * row — an incident with no cause in shipped code. The setup guard exists so no suite can
 * do that again, and this test is the thing that notices if the guard stops working.
 */
describe('tests never write the repository data directory', () => {
  it('points DATA_DIR somewhere disposable', () => {
    expect(process.env.DATA_DIR?.trim()).toBeTruthy();
    expect(resolve(getDataDir())).not.toBe(REPO_DATA_DIR);
  });

  it('keeps the default observability.json path out of the repository', () => {
    delete process.env.OBSERVABILITY_CONFIG_PATH;
    expect(resolve(runtimeConfigPath()).startsWith(REPO_DATA_DIR)).toBe(false);
  });

  it('leaves the repository observability.json untouched when a suite writes the default path', () => {
    const repoFile = resolve(REPO_DATA_DIR, 'config', 'observability.json');
    const before = existsSync(repoFile) ? readFileSync(repoFile, 'utf8') : null;

    delete process.env.OBSERVABILITY_CONFIG_PATH;
    writeRuntimeConfig({
      enabled: true,
      dsn: 'https://publickey@o123.ingest.sentry.io/999999',
      projectId: '999999',
      environment: 'production',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });

    const after = existsSync(repoFile) ? readFileSync(repoFile, 'utf8') : null;
    expect(after).toBe(before);
    expect(readFileSync(runtimeConfigPath(), 'utf8')).toContain('999999');
  });
});
