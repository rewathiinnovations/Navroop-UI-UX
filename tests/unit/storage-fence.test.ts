/**
 * The object-storage fence has to be true *inside a worker*, which is the only place
 * a test can write anything.
 *
 * `tests/setup/repo-write-guard.test.ts` proves the redirect function and proves the
 * guard declines to accuse a fenced root. Neither of those would notice the one
 * failure that matters: the import disappearing from `tests/setup/vitest.setup.ts`
 * or `tests/setup/repo-write-guard.global.ts`, leaving `lib/storage` back on its
 * `<cwd>/public/uploads` fallback while the guard, reading the same unset variable,
 * quietly stops watching it. That combination is worse than either half alone — the
 * suite could write the dev server's uploads and nothing would say so. This file
 * fails the moment it happens.
 *
 * Asserted against the environment variable rather than by calling into
 * `lib/storage`, because the resolution `localRoot()` performs — AppSetting row,
 * then env, then fallback — reads Prisma and memoises for thirty seconds, so a test
 * that went that way would be asserting the settings cache as much as the fence. The
 * registry hop is pinned separately below so the variable this checks is provably
 * the one that resolution reads.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SETTINGS } from '@/lib/settings/registry';
import { isInsideRepo } from '../setup/repo-write-guard';

const repoRoot = process.cwd();

describe('the object-storage fence, from inside a worker', () => {
  it('hands the worker a storage root outside the repository', () => {
    const configured = process.env.STORAGE_LOCAL_DIR;

    expect(configured, 'STORAGE_LOCAL_DIR is unset, so lib/storage falls back to public/uploads').toBeTruthy();
    expect(isAbsolute(configured as string)).toBe(true);
    expect(isInsideRepo(repoRoot, configured as string)).toBe(false);
  });

  it('keeps the fence clear of the uploads root the dev server serves', () => {
    const uploads = resolve(repoRoot, join('public', 'uploads'));

    expect(resolve(process.env.STORAGE_LOCAL_DIR as string)).not.toBe(uploads);
  });

  it('fences the variable that storage.localDir actually resolves through', () => {
    // Without this, renaming the registry's env hop would leave the fence pointing a
    // variable nothing consults and every assertion above still green.
    const entry = SETTINGS.find((setting) => setting.key === 'storage.localDir');

    expect(entry, 'the storage.localDir setting has gone').toBeDefined();
    expect(entry?.env).toBe('STORAGE_LOCAL_DIR');
  });
});
