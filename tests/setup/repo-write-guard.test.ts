/**
 * The guard exists to catch a suite writing the app's live state, so it has to be
 * able to fail. These tests build a temp stand-in for the repository root and prove
 * each rule separately — above all that a source edit outside the state paths does
 * NOT trip it, because five agents may be saving files while the suite runs.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STATE_PREFIXES,
  UPLOADS_PREFIX,
  compareSnapshots,
  formatViolations,
  gitIgnoredSubset,
  isInsideRepo,
  keepInvisibleAdditions,
  resolveFencedPrefixes,
  resolveStatePrefixes,
  snapshotTree,
  type CompareOptions,
} from './repo-write-guard';
import { fenceObjectStorage } from './storage-dir-guard';

let root: string;

/** No fence: every case below is the guard reading a tree it is entitled to accuse. */
const options: CompareOptions = { statePrefixes: DEFAULT_STATE_PREFIXES, allowlist: [], fencedPrefixes: [] };

/** Write a file, creating parents, and force a later mtime so the change is visible. */
function write(relativePath: string, contents: string) {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
  const later = new Date(statSync(full).mtimeMs + 5_000);
  utimesSync(full, later, later);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navroop-write-guard-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('repo write guard', () => {
  it('reports a file created under a state path', () => {
    const before = snapshotTree(root);
    write('.data/config/observability.json', '{"projectId":"456789"}');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: '.data/config/observability.json', kind: 'added' },
    ]);
  });

  it('reports an existing state file that was overwritten', () => {
    // The real incident: the file already existed and a fixture replaced it, so
    // an existence check alone would have missed it.
    write('.data/config/observability.json', '{"projectId":"real"}');
    const before = snapshotTree(root);
    write('.data/config/observability.json', '{"projectId":"456789-fixture"}');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: '.data/config/observability.json', kind: 'modified' },
    ]);
  });

  it('reports a state file the suite deleted', () => {
    write('public/uploads/logo.png', 'binary');
    const before = snapshotTree(root);
    rmSync(join(root, 'public/uploads/logo.png'));

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: 'public/uploads/logo.png', kind: 'removed' },
    ]);
  });

  it('reports an uploaded asset and a stray backup', () => {
    const before = snapshotTree(root);
    write('public/uploads/asset.webp', 'webp');
    write('tmp/backups/db-2026-08-18.sql.gz', 'gz');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: 'public/uploads/asset.webp', kind: 'added' },
      { path: 'tmp/backups/db-2026-08-18.sql.gz', kind: 'added' },
    ]);
  });

  it('ignores a source file edited outside the state paths', () => {
    // A concurrent agent saving lib/**. This is the false alarm the scoping avoids.
    write('lib/health/check.ts', 'export const a = 1;');
    const before = snapshotTree(root);
    write('lib/health/check.ts', 'export const a = 2; // edited by another agent');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([]);
  });

  it('still reports a file added outside the state paths', () => {
    const before = snapshotTree(root);
    write('stray-artifact.json', '{}');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: 'stray-artifact.json', kind: 'added' },
    ]);
  });

  it('does not walk skipped directories', () => {
    const before = snapshotTree(root);
    write('node_modules/.cache/thing', 'x');
    write('coverage/lcov.info', 'x');
    write('.next/build-manifest.json', '{}');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([]);
  });

  it('honours the allowlist', () => {
    const before = snapshotTree(root);
    write('.data/cache/github-token', 'x');

    expect(
      compareSnapshots(before, snapshotTree(root), { ...options, allowlist: ['.data/cache'] }),
    ).toEqual([]);
  });

  it('names every offending path in the failure message', () => {
    const message = formatViolations([
      { path: '.data/config/observability.json', kind: 'modified' },
      { path: 'public/uploads/asset.webp', kind: 'added' },
    ]);

    expect(message).toContain('.data/config/observability.json');
    expect(message).toContain('public/uploads/asset.webp');
    expect(message).toContain('wrote 2 files');
    // The remedy half. A reader who follows only the allowlist sentence quiets the
    // guard by deleting it, which is what the 2026-08-27 false alarm invited.
    expect(message).toContain('tests/setup/storage-dir-guard.ts');
  });
});

describe('visibility filter', () => {
  const statePrefixes = DEFAULT_STATE_PREFIXES;

  it('drops an added file that git can see', () => {
    // The false alarm the first real run produced: another agent adding a test.
    const kept = keepInvisibleAdditions([{ path: 'tests/integration/new-suite.test.ts', kind: 'added' }], {
      statePrefixes,
      ignoredPaths: new Set(),
    });

    expect(kept).toEqual([]);
  });

  it('keeps an added file that git ignores', () => {
    const kept = keepInvisibleAdditions([{ path: 'logs/run.json', kind: 'added' }], {
      statePrefixes,
      ignoredPaths: new Set(['logs/run.json']),
    });

    expect(kept).toEqual([{ path: 'logs/run.json', kind: 'added' }]);
  });

  it('keeps an added state file even when git can see it', () => {
    const kept = keepInvisibleAdditions([{ path: 'public/uploads/asset.webp', kind: 'added' }], {
      statePrefixes,
      ignoredPaths: new Set(),
    });

    expect(kept).toEqual([{ path: 'public/uploads/asset.webp', kind: 'added' }]);
  });

  it('never drops a modification or a removal', () => {
    const violations = [
      { path: '.data/config/observability.json', kind: 'modified' },
      { path: 'public/uploads/logo.png', kind: 'removed' },
    ] as const;

    expect(keepInvisibleAdditions(violations, { statePrefixes, ignoredPaths: new Set() })).toEqual([...violations]);
  });

  it('asks git and gets a usable answer in this repository', () => {
    // node_modules is ignored here and this file is not, which pins the direction
    // of the answer rather than just that git exited cleanly.
    const subset = gitIgnoredSubset(process.cwd(), [
      'node_modules/.bin/vitest',
      'tests/setup/repo-write-guard.test.ts',
    ]);

    expect(subset.available).toBe(true);
    expect(subset.paths.has('node_modules/.bin/vitest')).toBe(true);
    expect(subset.paths.has('tests/setup/repo-write-guard.test.ts')).toBe(false);
  });

  it('reports git as unavailable outside a repository instead of guessing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'navroop-no-repo-'));
    try {
      expect(gitIgnoredSubset(outside, ['anything.json']).available).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not shell out when there is nothing to classify', () => {
    expect(gitIgnoredSubset(process.cwd(), [])).toEqual({ paths: new Set(), available: true });
  });
});

describe('state prefixes', () => {
  it('adds DATA_DIR when it points inside the repository', () => {
    expect(resolveStatePrefixes(root, join(root, '.data-alt'))).toContain('.data-alt');
  });

  it('ignores a DATA_DIR outside the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'navroop-outside-'));
    try {
      expect(resolveStatePrefixes(root, outside)).toEqual([...DEFAULT_STATE_PREFIXES]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores an unset DATA_DIR', () => {
    expect(resolveStatePrefixes(root, undefined)).toEqual([...DEFAULT_STATE_PREFIXES]);
  });

  it('ignores a DATA_DIR on another Windows drive', () => {
    // `relative('D:\\repo', 'C:\\temp\\x')` returns `C:\temp\x` — absolute, and with
    // no leading `..` for a check that only looks for one. The repository sits on D:
    // and os.tmpdir() on C: on the machine this runs on, so treating that as "inside"
    // would add a drive-qualified key to the watch list. Skipped off Windows, where
    // the situation cannot arise.
    if (process.platform !== 'win32') return;
    expect(resolveStatePrefixes('D:\\repo', 'C:\\temp\\navroop')).toEqual([...DEFAULT_STATE_PREFIXES]);
  });
});

describe('containment', () => {
  it('reads a path on another Windows drive as outside', () => {
    if (process.platform !== 'win32') return;
    expect(isInsideRepo('D:\\repo', 'C:\\temp\\navroop-test-uploads-1')).toBe(false);
  });

  it('reads the repository root itself as inside', () => {
    expect(isInsideRepo(root, root)).toBe(true);
  });

  it('reads a subdirectory as inside and a sibling as outside', () => {
    expect(isInsideRepo(root, join(root, 'public', 'uploads'))).toBe(true);
    expect(isInsideRepo(root, join(root, '..', 'elsewhere'))).toBe(false);
  });
});

/**
 * The 2026-08-27 false alarm: the dev server wrote a preview build and a checkpoint
 * snapshot into `public/uploads` nine seconds into a run in which every one of 4,421
 * tests passed, and the guard reported them as the suite's. These cases pin the two
 * halves of the answer — the suite is fenced away from that root, and the guard
 * declines to accuse a root it has been fenced away from — and, above all, that the
 * fence is what buys the silence: with the storage root back inside the repository
 * every original verdict returns.
 */
describe('fenced prefixes', () => {
  it('fences the uploads root when object storage points outside the repository', () => {
    expect(resolveFencedPrefixes(root, join(root, '..', 'navroop-test-uploads'))).toEqual([UPLOADS_PREFIX]);
  });

  it('fences nothing while object storage still points inside the repository', () => {
    expect(resolveFencedPrefixes(root, join(root, 'public', 'uploads'))).toEqual([]);
    expect(resolveFencedPrefixes(root, join(root, '.tmp-store'))).toEqual([]);
  });

  it('fences nothing when object storage is unset or blank', () => {
    expect(resolveFencedPrefixes(root, undefined)).toEqual([]);
    expect(resolveFencedPrefixes(root, '   ')).toEqual([]);
  });

  it('says nothing about a preview build another process wrote while the suite ran', () => {
    const before = snapshotTree(root);
    write('public/uploads/previews/proj1/build1/index.html', '<!doctype html>');
    write('public/uploads/snapshots/proj1/check1.json.gz', 'gz');

    expect(
      compareSnapshots(before, snapshotTree(root), { ...options, fencedPrefixes: [UPLOADS_PREFIX] }),
    ).toEqual([]);
  });

  it('keeps every other state path accusable while the uploads root is fenced', () => {
    const before = snapshotTree(root);
    write('.data/config/observability.json', '{"projectId":"fixture"}');
    write('tmp/backups/db.sql.gz', 'gz');

    expect(
      compareSnapshots(before, snapshotTree(root), { ...options, fencedPrefixes: [UPLOADS_PREFIX] }),
    ).toEqual([
      { path: '.data/config/observability.json', kind: 'added' },
      { path: 'tmp/backups/db.sql.gz', kind: 'added' },
    ]);
  });

  it('accuses the same uploads write again the moment nothing is fenced', () => {
    // The guard is not being taught to like `public/uploads`; it is being told it
    // cannot be the author. Remove the fence and the original verdict returns.
    const before = snapshotTree(root);
    write('public/uploads/previews/proj1/build1/index.html', '<!doctype html>');

    expect(compareSnapshots(before, snapshotTree(root), options)).toEqual([
      { path: 'public/uploads/previews/proj1/build1/index.html', kind: 'added' },
    ]);
  });

  it('says nothing about an overwrite or a purge under a fenced root either', () => {
    // The dev server rewrites and prunes what it wrote. Additions are not the only
    // shape a live server leaves behind.
    write('public/uploads/projects/proj1/assets/a.webp', 'one');
    write('public/uploads/projects/proj1/assets/b.webp', 'two');
    const before = snapshotTree(root);
    write('public/uploads/projects/proj1/assets/a.webp', 'one-rebuilt');
    rmSync(join(root, 'public/uploads/projects/proj1/assets/b.webp'));

    expect(
      compareSnapshots(before, snapshotTree(root), { ...options, fencedPrefixes: [UPLOADS_PREFIX] }),
    ).toEqual([]);
  });
});

describe('the object-storage fence', () => {
  const saved = process.env.STORAGE_LOCAL_DIR;
  const minted: string[] = [];

  afterEach(() => {
    if (saved === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = saved;
    while (minted.length > 0) rmSync(minted.pop() as string, { recursive: true, force: true });
  });

  function fence(repoRoot: string) {
    const created = fenceObjectStorage(repoRoot);
    if (created) minted.push(created);
    return created;
  }

  it('redirects an unset storage root out of the repository', () => {
    delete process.env.STORAGE_LOCAL_DIR;
    const created = fence(root);

    expect(created).not.toBeNull();
    expect(process.env.STORAGE_LOCAL_DIR).toBe(created);
    expect(isInsideRepo(root, created as string)).toBe(false);
  });

  it('redirects a storage root that points inside the repository', () => {
    // The value `lib/storage` would otherwise fall back to.
    process.env.STORAGE_LOCAL_DIR = join(root, 'public', 'uploads');
    const created = fence(root);

    expect(created).not.toBeNull();
    expect(isInsideRepo(root, process.env.STORAGE_LOCAL_DIR as string)).toBe(false);
  });

  it('leaves a storage root that already sits outside the repository alone', () => {
    const chosen = mkdtempSync(join(tmpdir(), 'navroop-chosen-store-'));
    try {
      process.env.STORAGE_LOCAL_DIR = chosen;

      expect(fence(root)).toBeNull();
      expect(process.env.STORAGE_LOCAL_DIR).toBe(chosen);
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });
});
