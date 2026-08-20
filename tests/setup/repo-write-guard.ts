/**
 * A test must never write the state the running application reads.
 *
 * This is not hypothetical. `getDataDir()` falls back to `<cwd>/.data` outside
 * production, so a unit test stamped a fixture Sentry project id over the dev
 * server's live `config/observability.json`, and `/api/health` then reported the
 * file as disagreeing with the CONNECTED Integration row — a convincing incident
 * manufactured entirely by the test suite. `tests/setup/data-dir-guard.ts` closes
 * that particular route, but local object storage still falls back to
 * `public/uploads` and backups to `tmp/backups`.
 *
 * All four paths are gitignored, which is why `git status` is useless here and this
 * guard compares the filesystem instead.
 *
 * Three different questions, because several agents may be editing this checkout
 * while the suite runs:
 *
 * - **Modified or removed files, state paths only.** A source edit changes a file
 *   that already exists, so a repo-wide content comparison would fail on somebody
 *   else's save. Scoping content comparison to the application's own state paths
 *   catches the `observability.json` overwrite without that false alarm.
 * - **Added files under a state path.** Always a fault, whatever git thinks.
 * - **Added files elsewhere, only where git cannot see them.** Pollution lands in
 *   ignored directories — that is precisely why it goes unnoticed. A new *tracked*
 *   file is somebody adding a source file, which `git status` already shows; the
 *   first real run of this guard failed on exactly that, another agent creating
 *   `tests/integration/publish-compensate-resume.test.ts` mid-suite. So git is used
 *   to classify a candidate, never to detect the change — the detection is the mtime
 *   and size comparison below, because `git status` is blind to ignored paths.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Build output and dependency trees: churn constantly and are nobody's state. */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  '.turbo',
  'generated',
  'playwright-report',
  'test-results',
  'dist',
  'build',
  'out',
  '.vercel',
]);

/**
 * The paths a misconfigured suite writes instead of a temp directory:
 * `DATA_DIR` (observability config, caches), `STORAGE_LOCAL_DIR` (uploaded
 * assets), and the backup destination.
 */
export const DEFAULT_STATE_PREFIXES: readonly string[] = ['.data', 'public/uploads', 'tmp/backups'];

/**
 * Deliberately tiny. An entry belongs here only if the *harness* writes it, never
 * because a test was observed leaving something behind — that is the finding, not
 * an exception. Every entry carries its reason.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  // The v8 coverage provider writes here; also in SKIP_DIRECTORIES, kept for the
  // case where a reporter is pointed somewhere shallower.
  'coverage',
  // Written create-if-absent by the E2E harness (`localOnlyPassword` in
  // e2e/support/account.ts, F-612): the per-machine seeded password. No vitest
  // path can create it — only playwright/scripts do — but a concurrent verify
  // or playwright run in another shell may create it inside a vitest snapshot
  // window, and that is the harness's own output, not a test leaving state.
  'e2e/.auth/local-password',
];

export type FileFacts = { mtimeMs: number; size: number };
export type TreeSnapshot = Map<string, FileFacts>;

/** Repo-relative, forward slashes, so keys and allowlist entries compare on any OS. */
export function toKey(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}

export function snapshotTree(root: string): TreeSnapshot {
  const files: TreeSnapshot = new Map();
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Vanished or unreadable mid-walk. Not something this guard should assert on.
      continue;
    }

    for (const entry of entries) {
      // Never follow a symlink: the target is outside our accounting and the walk
      // could cycle.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(full);
        files.set(toKey(root, full), { mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        continue;
      }
    }
  }

  return files;
}

export type WriteViolation = { path: string; kind: 'added' | 'modified' | 'removed' };

export type CompareOptions = {
  /** Repo-relative prefixes whose file contents are compared, not just their existence. */
  statePrefixes: readonly string[];
  /** Repo-relative paths or directory prefixes that may change without failing. */
  allowlist: readonly string[];
};

function matchesPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
}

export function compareSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
  options: CompareOptions,
): WriteViolation[] {
  const violations: WriteViolation[] = [];
  const allowed = (key: string) => matchesPrefix(key, options.allowlist);
  const isState = (key: string) => matchesPrefix(key, options.statePrefixes);

  for (const [key, facts] of after) {
    if (allowed(key)) continue;
    const previous = before.get(key);
    if (!previous) {
      violations.push({ path: key, kind: 'added' });
      continue;
    }
    if (!isState(key)) continue;
    if (previous.mtimeMs !== facts.mtimeMs || previous.size !== facts.size) {
      violations.push({ path: key, kind: 'modified' });
    }
  }

  for (const key of before.keys()) {
    if (allowed(key) || after.has(key)) continue;
    // Deleting the app's state is the same class of harm as overwriting it.
    if (isState(key)) violations.push({ path: key, kind: 'removed' });
  }

  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * `DATA_DIR` joins the state paths when it points inside the repo — that fallback
 * is exactly how a test reached the running app's config.
 */
export function resolveStatePrefixes(root: string, dataDir: string | undefined): string[] {
  const prefixes: string[] = [...DEFAULT_STATE_PREFIXES];
  const configured = dataDir?.trim();
  if (!configured) return prefixes;

  const key = toKey(root, resolve(root, configured));
  const insideRepo = key.length > 0 && !key.startsWith('..');
  if (insideRepo && !prefixes.includes(key)) prefixes.push(key);
  return prefixes;
}

export type VisibilityOptions = {
  statePrefixes: readonly string[];
  /** The subset of candidate paths that git ignores. Injected so this stays testable. */
  ignoredPaths: ReadonlySet<string>;
};

/**
 * Drop added files that git can see. Someone adding a source file is not pollution,
 * and a tracked or merely-untracked addition already shows up in `git status`; what
 * this guard is here for is the writes that do not.
 */
export function keepInvisibleAdditions(
  violations: readonly WriteViolation[],
  options: VisibilityOptions,
): WriteViolation[] {
  return violations.filter((violation) => {
    if (violation.kind !== 'added') return true;
    if (matchesPrefix(violation.path, options.statePrefixes)) return true;
    return options.ignoredPaths.has(violation.path);
  });
}

export type IgnoredSubset = {
  paths: ReadonlySet<string>;
  /** False when git could not answer, so the caller can say so instead of guessing. */
  available: boolean;
};

/**
 * Ask git which of these paths it ignores. `git check-ignore` reports only ignored
 * paths, so a tracked or untracked-but-visible file is simply absent from the reply.
 */
export function gitIgnoredSubset(root: string, paths: readonly string[]): IgnoredSubset {
  if (paths.length === 0) return { paths: new Set(), available: true };

  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd: root,
    input: `${paths.join('\0')}\0`,
    encoding: 'utf8',
    windowsHide: true,
  });

  // 0 = some ignored, 1 = none ignored. Anything else (no git, not a repo) is an
  // answer we do not have.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return { paths: new Set(), available: false };
  }

  const reported = (result.stdout || '').split('\0').filter((entry) => entry.length > 0);
  return { paths: new Set(reported), available: true };
}

export function formatViolations(violations: readonly WriteViolation[]): string {
  const count = violations.length;
  return [
    `The test run wrote ${count} file${count === 1 ? '' : 's'} in the repository that it does not own:`,
    ...violations.map((violation) => `  ${violation.kind.padEnd(8)} ${violation.path}`),
    '',
    'These paths are gitignored, so `git status` cannot show you this.',
    'A suite that writes .data/, public/uploads, or tmp/backups is writing the state',
    'the running app reads. Point it at a temp directory instead — DATA_DIR,',
    'STORAGE_LOCAL_DIR, or the backup destination — the way',
    'tests/setup/data-dir-guard.ts does for DATA_DIR.',
    '',
    'If a path is genuinely the harness\u2019s own output, add it to DEFAULT_ALLOWLIST',
    'in tests/setup/repo-write-guard.ts with the reason it belongs there.',
  ].join('\n');
}
