/**
 * Vitest `globalSetup`: snapshot the repository before the suite, compare after.
 *
 * This runs in its own process, so it cannot see the temp directory that
 * `tests/setup/data-dir-guard.ts` puts in `DATA_DIR` for the worker processes — and
 * it does not need to. It only needs the repository root, because the whole point
 * is to notice writes that land *here* rather than in a temp directory.
 *
 * The engine lives in `./repo-write-guard` so it can be tested directly; this file
 * is only the wiring.
 *
 * `./storage-dir-guard` is imported for its side effect and imported *here* rather
 * than only in `vitest.setup.ts` because this module is evaluated in the main
 * process before the worker pool is forked: the workers then inherit the fence
 * instead of each minting its own, and this process can read the same
 * `STORAGE_LOCAL_DIR` in `teardown` to decide what it is still entitled to accuse.
 */
import './storage-dir-guard';
import {
  DEFAULT_ALLOWLIST,
  compareSnapshots,
  formatViolations,
  gitIgnoredSubset,
  keepInvisibleAdditions,
  resolveFencedPrefixes,
  resolveStatePrefixes,
  snapshotTree,
  type TreeSnapshot,
} from './repo-write-guard';

const root = process.cwd();
let before: TreeSnapshot | null = null;

export function setup() {
  before = snapshotTree(root);
}

export function teardown() {
  if (!before) return;

  const statePrefixes = resolveStatePrefixes(root, process.env.DATA_DIR);
  const fencedPrefixes = resolveFencedPrefixes(root, process.env.STORAGE_LOCAL_DIR);
  const candidates = compareSnapshots(before, snapshotTree(root), {
    statePrefixes,
    allowlist: DEFAULT_ALLOWLIST,
    fencedPrefixes,
  });

  const added = candidates.filter((violation) => violation.kind === 'added').map((violation) => violation.path);
  const ignored = gitIgnoredSubset(root, added);
  if (!ignored.available && added.length > 0) {
    // Say so rather than silently narrowing the check.
    console.warn(
      '[repo-write-guard] git could not classify added paths, so only the state paths were checked for additions.',
    );
  }

  const violations = keepInvisibleAdditions(candidates, { statePrefixes, ignoredPaths: ignored.paths });
  if (violations.length === 0) return;

  // Throwing is the documented way to fail from teardown, but set the code too so
  // the gate does not depend on how the runner chooses to report a teardown error.
  process.exitCode = 1;
  throw new Error(formatViolations(violations));
}
