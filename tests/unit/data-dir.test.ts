import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeDataDir } from '../../lib/health/check';
import { reconcileRuntimeConfig } from '../../lib/observability/boot';
import {
  readRuntimeConfig,
  resetRuntimeConfigForTests,
  runtimeConfigPath,
  writeRuntimeConfig,
} from '../../lib/observability/runtime-config';
import {
  LARGE_OP_MIN_FREE_BYTES,
  VOLUME_ID_SETTING_KEY,
  assertFreeSpaceForLargeOp,
  cachePath,
  ensureDataDir,
  getDataDir,
  getDataDirStatus,
  persistVolumeIdentity,
  resetDataDirForTests,
  sweepTmp,
  withTmpDir,
} from '../../lib/runtime/data-dir';

const VALID_DSN = 'https://publickey@o123.ingest.sentry.io/456789';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'navroop-data-'));
}

describe('persistent data dir', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousObs: string | undefined;
  const logs: string[] = [];

  beforeEach(() => {
    root = tempRoot();
    previousDataDir = process.env.DATA_DIR;
    previousObs = process.env.OBSERVABILITY_CONFIG_PATH;
    process.env.DATA_DIR = root;
    delete process.env.OBSERVABILITY_CONFIG_PATH;
    resetDataDirForTests();
    resetRuntimeConfigForTests();
    logs.length = 0;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousObs === undefined) delete process.env.OBSERVABILITY_CONFIG_PATH;
    else process.env.OBSERVABILITY_CONFIG_PATH = previousObs;
    resetDataDirForTests();
    resetRuntimeConfigForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it('starts without a volume, logs the path, and reports not writable', () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'not-a-directory');
    const missing = join(blocker, 'data');
    process.env.DATA_DIR = missing;
    resetDataDirForTests();

    expect(() =>
      ensureDataDir({
        logError: (message) => logs.push(message),
      }),
    ).not.toThrow();

    const status = getDataDirStatus();
    expect(status.writable).toBe(false);
    expect(status.path).toBe(missing);
    expect(logs.some((line) => line.includes(missing))).toBe(true);
    expect(status.error).toMatch(/not writable|not mounted|ownership/i);
  });

  it('names ownership when a non-root user cannot write a root-owned volume', () => {
    ensureDataDir({
      probeWrite: () => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      userInfo: { uid: 1001, username: 'nextjs' },
      logError: (message) => logs.push(message),
    });

    const status = getDataDirStatus();
    expect(status.writable).toBe(false);
    expect(status.error).toMatch(/ownership/i);
    expect(status.error).toMatch(/nextjs|uid 1001|non-root/i);
    expect(logs.join('\n')).toMatch(/ownership/i);
  });

  it('reports "not checked yet" before the boot probe runs, without claiming an error', () => {
    resetDataDirForTests();

    const status = getDataDirStatus();
    expect(status.checked).toBe(false);
    expect(status.error).toBeNull();
    expect(status.volumeId).toBeNull();

    const described = describeDataDir(status);
    expect(described.state).toBe('not_checked');
    expect(described.message).toMatch(/has not been checked yet/i);
    expect(described.message).toMatch(/not a failure/i);
    expect(described.message).not.toMatch(/not writable|not mounted|missing/i);
  });

  it('separates an unwritable volume from a volume nobody has probed', () => {
    const unprobed = describeDataDir(getDataDirStatus());

    ensureDataDir({
      probeWrite: () => {
        const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      logError: (message) => logs.push(message),
    });
    const failed = describeDataDir(getDataDirStatus());

    expect(unprobed.state).toBe('not_checked');
    expect(failed.state).toBe('unwritable');
    expect(failed.checked).toBe(true);
    expect(failed.message).toMatch(/not writable/i);
    expect(failed.message).not.toBe(unprobed.message);
  });

  it('says the volume is mounted and writable once the probe succeeds', () => {
    ensureDataDir();
    const described = describeDataDir(getDataDirStatus());
    expect(described.state).toBe('ok');
    expect(described.checked).toBe(true);
    expect(described.message).toMatch(/mounted and writable/i);
  });

  it('creates config/cache/tmp and a volume id on the first successful write', () => {
    const status = ensureDataDir();
    expect(status.writable).toBe(true);
    expect(existsSync(join(root, 'config'))).toBe(true);
    expect(existsSync(join(root, 'cache'))).toBe(true);
    expect(existsSync(join(root, 'tmp'))).toBe(true);
    expect(status.volumeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(status.volumeCreatedAt).toBeTruthy();
    const raw = JSON.parse(readFileSync(join(root, '.volume-id'), 'utf8')) as {
      id: string;
      createdAt: string;
    };
    expect(raw.id).toBe(status.volumeId);
  });

  it('keeps the same volume id across two boots', () => {
    const first = ensureDataDir();
    resetDataDirForTests();
    const second = ensureDataDir();
    expect(second.volumeId).toBe(first.volumeId);
    expect(second.volumeChanged).toBe(false);
  });

  it('reports a volume id change when the id file is removed after a previous boot', async () => {
    const first = ensureDataDir();
    const store = { value: first.volumeId };
    await persistVolumeIdentity({
      getPrevious: async () => store.value,
      setPrevious: async (id) => {
        store.value = id;
      },
    });

    rmSync(join(root, '.volume-id'), { force: true });
    resetDataDirForTests();
    const second = ensureDataDir();
    expect(second.volumeId).not.toBe(first.volumeId);

    const persisted = await persistVolumeIdentity({
      getPrevious: async () => store.value,
      setPrevious: async (id) => {
        store.value = id;
      },
      warn: (message) => logs.push(message),
    });
    expect(persisted.changed).toBe(true);
    expect(persisted.previousId).toBe(first.volumeId);
    expect(getDataDirStatus().volumeChanged).toBe(true);
    expect(logs.join('\n')).toMatch(/volume id changed|lost mount|fresh/i);
  });

  it('recovers after the entire volume is deleted with a new volume id', () => {
    const first = ensureDataDir();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    resetDataDirForTests();
    const second = ensureDataDir();
    expect(second.writable).toBe(true);
    expect(second.volumeId).toBeTruthy();
    expect(second.volumeId).not.toBe(first.volumeId);
    expect(existsSync(join(root, 'config'))).toBe(true);
  });

  it('sweeps tmp files older than one hour on startup', () => {
    ensureDataDir();
    const stale = join(root, 'tmp', 'stale-dir');
    const fresh = join(root, 'tmp', 'fresh-dir');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, 'old.txt'), 'old');
    writeFileSync(join(fresh, 'new.txt'), 'new');
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    const result = sweepTmp({ now: new Date() });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('removes withTmpDir work in finally even when the writer throws', async () => {
    ensureDataDir();
    let captured = '';
    await expect(
      withTmpDir(async (dir) => {
        captured = dir;
        expect(dir.startsWith(join(root, 'tmp'))).toBe(true);
        writeFileSync(join(dir, 'dump.sql'), 'x');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(captured).toBeTruthy();
    expect(existsSync(captured)).toBe(false);
  });

  it('refuses a large op when free space is under 2 GB', () => {
    ensureDataDir({
      disk: { freeBytes: LARGE_OP_MIN_FREE_BYTES - 1, totalBytes: 20 * 1024 * 1024 * 1024 },
    });
    expect(() => assertFreeSpaceForLargeOp()).toThrow(/2 GB/i);
    expect(() => assertFreeSpaceForLargeOp()).toThrow(/free space/i);
  });

  it('defaults observability.json under DATA_DIR/config', () => {
    expect(getDataDir()).toBe(root);
    expect(runtimeConfigPath().replace(/\\/g, '/')).toBe(`${root.replace(/\\/g, '/')}/config/observability.json`);
  });

  it('rebuilds a missing observability.json from the Integration row', async () => {
    ensureDataDir();
    const result = await reconcileRuntimeConfig({
      getConnected: async () => ({
        status: 'CONNECTED',
        config: {
          dsn: VALID_DSN,
          projectId: '456789',
          environment: 'production',
        },
      }),
    });
    expect(result.rewrote).toBe(true);
    expect(readRuntimeConfig()?.projectId).toBe('456789');
    expect(existsSync(join(root, 'config', 'observability.json'))).toBe(true);
  });

  it('rebuilds corrupt observability.json from the Integration row without crashing', async () => {
    ensureDataDir();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'observability.json'), '{not-json', 'utf8');
    expect(() => readRuntimeConfig()).not.toThrow();
    expect(readRuntimeConfig()).toBeNull();

    const result = await reconcileRuntimeConfig({
      getConnected: async () => ({
        status: 'CONNECTED',
        config: {
          dsn: VALID_DSN,
          projectId: '456789',
          environment: 'production',
        },
      }),
    });
    expect(result.rewrote).toBe(true);
    expect(readRuntimeConfig()?.projectId).toBe('456789');
  });

  it('never uses DATA_DIR for checkpoints, images, backups, or secrets', () => {
    expect(VOLUME_ID_SETTING_KEY).toBe('runtime.volumeId');
    expect(cachePath('github-tokens.json').replace(/\\/g, '/')).toMatch(/\/cache\/github-tokens\.json$/);
    const source = readFileSync(join(process.cwd(), 'lib/runtime/data-dir.ts'), 'utf8');
    expect(source).toMatch(/reconstructible from Postgres or object storage/);
    expect(source).not.toMatch(/snapshots\//);
    for (const file of [
      'lib/checkpoints/snapshot-store.ts',
      'lib/storage/index.ts',
      'lib/backup/client.ts',
      'lib/crypto.ts',
    ]) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      expect(text).not.toMatch(/DATA_DIR/);
    }
  });

  it('refuses a database backup before writing when free space is under 2 GB', async () => {
    const prevElk = process.env.ELK_BUCKET;
    const prevBackup = process.env.BACKUP_BUCKET;
    process.env.ELK_BUCKET = 'navroop-assets-test';
    process.env.BACKUP_BUCKET = 'navroop-backups-test';
    ensureDataDir({
      disk: { freeBytes: LARGE_OP_MIN_FREE_BYTES - 1, totalBytes: 20 * 1024 * 1024 * 1024 },
    });
    try {
      const { runDbBackup } = await import('../../lib/backup/db');
      const result = await runDbBackup();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/2 GB/i);
    } finally {
      if (prevElk === undefined) delete process.env.ELK_BUCKET;
      else process.env.ELK_BUCKET = prevElk;
      if (prevBackup === undefined) delete process.env.BACKUP_BUCKET;
      else process.env.BACKUP_BUCKET = prevBackup;
    }
  });
});
