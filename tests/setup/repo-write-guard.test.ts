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
  compareSnapshots,
  formatViolations,
  gitIgnoredSubset,
  keepInvisibleAdditions,
  resolveStatePrefixes,
  snapshotTree,
  type CompareOptions,
} from './repo-write-guard';

let root: string;

const options: CompareOptions = { statePrefixes: DEFAULT_STATE_PREFIXES, allowlist: [] };

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
});
