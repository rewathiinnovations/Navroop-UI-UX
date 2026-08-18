import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync,
}));

import { ensurePostgresDatabase } from '../../lib/verify/ensure-db';

function enoent() {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function spawnResult(partial: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  return {
    status: partial.status ?? 0,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    error: partial.error,
    pid: 1,
    output: [null, partial.stdout ?? '', partial.stderr ?? ''] as [null, string, string],
    signal: null,
  };
}

describe('ensurePostgresDatabase', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    delete process.env.POSTGRES_CONTAINER;
  });

  it('rejects an unsafe database name', () => {
    expect(ensurePostgresDatabase({ adminUrl: 'postgresql://x:y@127.0.0.1:5433/postgres', name: 'bad-name' })).toEqual({
      ok: false,
      created: false,
      output: 'Invalid database name: bad-name',
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports an existing database from host psql', () => {
    spawnSync.mockReturnValue(spawnResult({ stdout: ' 1\n' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: true,
      created: false,
      output: 'Database openlovable_shadow already exists',
    });
    expect(spawnSync).toHaveBeenCalledWith(
      'psql',
      expect.arrayContaining(['-tc']),
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('creates the database when the lookup is empty', () => {
    spawnSync
      .mockReturnValueOnce(spawnResult({ stdout: '' }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: 'CREATE DATABASE\n' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: true,
      created: true,
      output: 'Created database openlovable_shadow',
    });
  });

  it('returns the lookup error when psql cannot query pg_database', () => {
    spawnSync.mockReturnValue(spawnResult({ status: 2, stderr: 'connection refused' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: false,
      created: false,
      output: 'connection refused',
    });

    spawnSync.mockReturnValue(spawnResult({ status: 2, stdout: '', stderr: '' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }).output,
    ).toMatch(/psql failed/);
  });

  it('returns a CREATE DATABASE failure', () => {
    spawnSync
      .mockReturnValueOnce(spawnResult({ stdout: '' }))
      .mockReturnValueOnce(spawnResult({ status: 1, stderr: 'permission denied' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: false,
      created: false,
      output: 'permission denied',
    });

    spawnSync
      .mockReturnValueOnce(spawnResult({ stdout: '' }))
      .mockReturnValueOnce(spawnResult({ status: 1, stdout: '', stderr: '' }));
    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }).output,
    ).toBe('CREATE DATABASE failed');
  });

  it('falls back to a running docker container when host psql is missing', () => {
    spawnSync.mockImplementation((command: string, args: string[] = []) => {
      if (command === 'psql') return spawnResult({ error: enoent() });
      if (command === 'docker' && args[0] === 'inspect') {
        return spawnResult({ stdout: 'true\n' });
      }
      if (command === 'docker' && args[0] === 'exec') {
        return spawnResult({ stdout: '1\n' });
      }
      return spawnResult({ status: 1, stderr: `unexpected ${command}` });
    });

    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:secret@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: true,
      created: false,
      output: 'Database openlovable_shadow already exists',
    });
    expect(spawnSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', '-i', 'open-lovable-db', 'psql', '-U', 'openlovable', '-d', 'openlovable_test']),
      expect.any(Object),
    );
  });

  it('discovers a postgres container when inspect says it is down', () => {
    process.env.POSTGRES_CONTAINER = 'custom-pg';
    spawnSync.mockImplementation((command: string, args: string[] = []) => {
      if (command === 'psql') return spawnResult({ error: enoent() });
      if (command === 'docker' && args[0] === 'inspect') {
        return spawnResult({ status: 1, stdout: 'false\n' });
      }
      if (command === 'docker' && args[0] === 'ps') {
        return spawnResult({ stdout: 'ci-postgres\n' });
      }
      if (command === 'docker' && args[0] === 'exec') {
        expect(args).toContain('ci-postgres');
        return spawnResult({ stdout: '1\n' });
      }
      return spawnResult({ status: 1 });
    });

    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://ci:ci@127.0.0.1:5432/postgres',
        name: 'openlovable_shadow',
      }).ok,
    ).toBe(true);
  });

  it('skips when neither psql nor docker is available', () => {
    spawnSync.mockImplementation((command: string) => {
      if (command === 'psql') return spawnResult({ error: enoent() });
      return spawnResult({ error: enoent() });
    });

    expect(
      ensurePostgresDatabase({
        adminUrl: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        name: 'openlovable_shadow',
      }),
    ).toEqual({
      ok: false,
      created: false,
      skipped: true,
      output: 'psql and docker are unavailable; cannot create the shadow database',
    });
  });
});
