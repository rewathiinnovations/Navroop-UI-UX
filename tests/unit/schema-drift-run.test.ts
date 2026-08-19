import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
const ensurePostgresDatabase = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync,
}));

vi.mock('../../lib/verify/ensure-db', () => ({
  ensurePostgresDatabase,
}));

import { DEFAULT_SHADOW_DATABASE_NAME, runSchemaDriftCheck } from '../../lib/verify/schema-drift';

const APP = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable';
const TEST = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test';
const SHADOW = 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_shadow';
const ADMIN = 'postgresql://openlovable:openlovable@127.0.0.1:5433/postgres';

function spawnResult(partial: { status?: number | null; stdout?: string; stderr?: string }) {
  return {
    status: partial.status ?? 0,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    pid: 1,
    output: [null, partial.stdout ?? '', partial.stderr ?? ''] as [null, string, string],
    signal: null,
  };
}

describe('schema drift runners', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    ensurePostgresDatabase.mockReset();
    ensurePostgresDatabase.mockReturnValue({ ok: true, created: false, output: 'exists' });
    spawnSync.mockReturnValue(spawnResult({ status: 0, stdout: '' }));
  });

  it('fails closed when the shadow URL is the app database', () => {
    const result = runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
      SHADOW_DATABASE_URL: APP,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/must not be DATABASE_URL/);
    expect(ensurePostgresDatabase).not.toHaveBeenCalled();
  });

  it('returns the ensure-db error without spawning prisma', () => {
    ensurePostgresDatabase.mockReturnValue({ ok: false, created: false, output: 'psql failed' });
    const result = runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
    });
    expect(result).toEqual({ ok: false, output: 'psql failed' });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('uses TEST_DATABASE_ADMIN_URL and a successful prisma diff', () => {
    const result = runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
      TEST_DATABASE_ADMIN_URL: ADMIN,
    });
    expect(result.ok).toBe(true);
    expect(ensurePostgresDatabase).toHaveBeenCalledWith({
      adminUrl: ADMIN,
      name: DEFAULT_SHADOW_DATABASE_NAME,
    });
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['migrate', 'diff', '--shadow-database-url', SHADOW]),
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('falls back to TEST_DATABASE_URL as admin when the admin URL is the shadow', () => {
    runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
      TEST_DATABASE_ADMIN_URL: SHADOW,
    });
    expect(ensurePostgresDatabase).toHaveBeenCalledWith({
      adminUrl: TEST,
      name: DEFAULT_SHADOW_DATABASE_NAME,
    });
  });

  it('falls back to DATABASE_URL as admin when no test URL is set', () => {
    runSchemaDriftCheck({
      DATABASE_URL: APP,
    });
    expect(ensurePostgresDatabase).toHaveBeenCalledWith({
      adminUrl: APP,
      name: DEFAULT_SHADOW_DATABASE_NAME,
    });
  });

  it('uses the postgres maintenance DB when no other admin URL is available', () => {
    runSchemaDriftCheck({
      SHADOW_DATABASE_URL: SHADOW,
    });
    expect(ensurePostgresDatabase).toHaveBeenCalledWith({
      adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/postgres',
      name: DEFAULT_SHADOW_DATABASE_NAME,
    });
  });

  it('returns prisma stdout and stderr when migrate diff fails', () => {
    spawnSync.mockReturnValue(spawnResult({ status: 2, stdout: 'drift\n', stderr: 'hint\n' }));
    const result = runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('drift');
    expect(result.output).toContain('hint');
  });

  it('names an unparseable shadow URL as the default database', () => {
    runSchemaDriftCheck({
      DATABASE_URL: APP,
      TEST_DATABASE_URL: TEST,
      SHADOW_DATABASE_URL: 'not-a-url',
    });
    expect(ensurePostgresDatabase).toHaveBeenCalledWith({
      adminUrl: TEST,
      name: DEFAULT_SHADOW_DATABASE_NAME,
    });
  });
});
