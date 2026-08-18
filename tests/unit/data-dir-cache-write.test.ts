import '../setup/data-dir-guard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `writeCacheJson` used to unlink the destination before renaming the temp file over it, so a
 * failed rename left no file at all: a failed write destroyed the previous good value, with an
 * empty catch on top of it. The observable cost was a dropped GitHub installation token cache,
 * which makes every publish re-mint a token, and nothing was ever logged.
 */

const fail = { rename: false };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (fail.rename) throw new Error('EPERM: simulated rename failure');
    return actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const FILE = 'cache-write-probe.json';

let dataDir: typeof import('@/lib/runtime/data-dir');
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  fail.rename = false;
  dataDir = await import('@/lib/runtime/data-dir');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  fail.rename = false;
  warn.mockRestore();
});

describe('writeCacheJson', () => {
  it('writes a value that reads back', () => {
    expect(dataDir.writeCacheJson(FILE, { generation: 1 })).toEqual({ ok: true });
    expect(dataDir.readCacheJson<{ generation: number }>(FILE)).toEqual({ generation: 1 });
  });

  it('keeps the previous good value when the write fails', () => {
    dataDir.writeCacheJson(FILE, { generation: 1 });

    fail.rename = true;
    const result = dataDir.writeCacheJson(FILE, { generation: 2 });

    // Non-throwing is part of the contract: callers treat the volume cache as optional.
    expect(result.ok).toBe(false);
    // The whole point. Before the reorder this read `null` — the good value was unlinked
    // before the rename that then failed.
    expect(dataDir.readCacheJson<{ generation: number }>(FILE)).toEqual({ generation: 1 });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('could not write a cache file');
  });

  it('does not leave the temp file behind after a failed write', async () => {
    dataDir.writeCacheJson(FILE, { generation: 1 });
    fail.rename = true;
    dataDir.writeCacheJson(FILE, { generation: 2 });

    const { existsSync } = await import('node:fs');
    expect(existsSync(`${dataDir.cachePath(FILE)}.${process.pid}.tmp`)).toBe(false);
  });

  it('recovers on the next successful write', () => {
    dataDir.writeCacheJson(FILE, { generation: 1 });
    fail.rename = true;
    dataDir.writeCacheJson(FILE, { generation: 2 });
    fail.rename = false;

    expect(dataDir.writeCacheJson(FILE, { generation: 3 })).toEqual({ ok: true });
    expect(dataDir.readCacheJson<{ generation: number }>(FILE)).toEqual({ generation: 3 });
  });
});
