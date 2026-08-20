import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

/**
 * Coverage excludes and per-path floors are written against directories that exist at
 * the time. When a subsystem is deleted, the entries that named it survive and read as
 * deliberate policy — F-616: `exclude: ['lib/e2b-backends/**', …]` outlived the sandbox
 * subsystem by a day and pointed at nothing, while the floors it had justified stayed
 * lowered. A per-path floor that matches no file is worse: it silently enforces nothing.
 *
 * Every glob here therefore has to match at least one real path.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Globs that name a directory of files vitest generates, so they are legitimately absent. */
const ALLOWED_ABSENT = ['lib/**/*.d.ts'];

function matches(pattern: string) {
  return globSync(pattern, { cwd: ROOT }).length > 0;
}

describe('the coverage config points at paths that exist', () => {
  const coverage = config.test?.coverage;
  const exclude = coverage && 'exclude' in coverage ? (coverage.exclude ?? []) : [];
  const thresholds = coverage && 'thresholds' in coverage ? (coverage.thresholds ?? {}) : {};
  const perPathFloors = Object.keys(thresholds).filter((key) => key.includes('/'));

  it('reads the config it is checking', () => {
    // Anti-vacuity: an empty read would satisfy both cases below.
    expect(exclude.length).toBeGreaterThan(1);
    expect(perPathFloors.length).toBeGreaterThan(3);
  });

  it('excludes only paths that are still in the tree', () => {
    const dead = exclude.filter((glob) => !ALLOWED_ABSENT.includes(glob) && !matches(glob));
    expect(dead, `coverage.exclude names nothing: ${dead.join(', ')}`).toEqual([]);
  });

  it('sets per-path floors only on paths that are still in the tree', () => {
    const dead = perPathFloors.filter((glob) => !matches(glob));
    expect(dead, `a per-path coverage floor enforces nothing: ${dead.join(', ')}`).toEqual([]);
  });
});
