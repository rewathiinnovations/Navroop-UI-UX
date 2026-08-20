/**
 * Secret scanner used by the pre-commit hook and by the `verify` gate.
 * Prefers gitleaks when installed; always runs the in-repo PEM/key rules.
 *
 * Modes:
 *   --staged   the index blobs of the staged paths — what this commit will contain
 *   --tracked  every file git has under version control — what the repository
 *              already contains. This is the `verify` gate's input: `verify:bypass`
 *              is a documented escape hatch, so a `--no-verify` commit skips the
 *              pre-commit scan and, before 2026-08-21, was never scanned again by
 *              anything (F-785). Ignored paths are absent by construction, so a
 *              developer's own `.env.local` cannot hold the gate red — its *staged*
 *              copy is still blocked by `--staged`.
 *   (default)  the whole working tree, ignored files included. A local audit, not a
 *              gate: it reports the real keys in `.env.local` on purpose.
 *   <paths>    the paths named on the command line
 *
 * Fails closed: a scan that cannot enumerate its input, or cannot read a file it
 * was asked to check, must never report a pass. Exit codes are distinct so a
 * developer knows which problem they have:
 *   0 — scanned clean (or there was genuinely nothing staged)
 *   1 — a secret was found; look at the finding
 *   2 — the scan could not run; nothing was examined
 * Diagnostics go to stderr because that is what a git hook shows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanFilesForSecrets, shouldScanPath } from '../lib/secret-scan.ts';

const EXIT_SECRET_FOUND = 1;
const EXIT_SCAN_FAILED = 2;

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage']);
const MAX_BUFFER = 64 * 1024 * 1024;

type ReadResult = { ok: true; text: string } | { ok: false; error: string };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function commandStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const raw = (error as { stderr?: string | Buffer | null }).stderr;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

/** execFileSync already folds stderr into the message; de-duplicate the lines. */
function failureLines(error: unknown): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const row of `${messageOf(error)}\n${commandStderr(error)}`.split(/\r?\n/)) {
    const trimmed = row.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    rows.push(trimmed);
  }
  return rows;
}

/** Loud, closed exit: the gate did not do its job, so it cannot report a pass. */
function abort(reason: string, detail: string[]): never {
  console.error(`Secret scan could not complete: ${reason}`);
  for (const row of detail) console.error(`  ${row}`);
  console.error(
    '  Exit 2 means a broken scan, not a secret finding: staged content went unexamined.',
  );
  console.error('  This is NOT a pass. Fix the scanner or the repo state, then commit again.');
  process.exit(EXIT_SCAN_FAILED);
}

function git(args: string[], reason: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    abort(reason, [`git ${args.join(' ')}`, ...failureLines(error)]);
  }
}

function listFiles(root: string, acc: string[] = []) {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    abort('a directory in the working tree could not be listed', [`${root} — ${messageOf(error)}`]);
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    try {
      if (statSync(full).isDirectory()) listFiles(full, acc);
      else acc.push(full);
    } catch (error) {
      abort('a path in the working tree could not be inspected', [`${full} — ${messageOf(error)}`]);
    }
  }
  return acc;
}

/** `-z` so unusual filenames arrive verbatim instead of core.quotepath-escaped. */
function stagedPaths(): string[] {
  const out = git(
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    'git could not list the staged files',
  );
  return out
    .split('\0')
    .map((row) => row.trim())
    .filter(Boolean);
}

/**
 * Everything git has under version control, ignored paths excluded by
 * construction. `--cached` so a staged addition is scanned before it is
 * committed as well as after.
 */
function trackedPaths(): string[] {
  const out = git(['ls-files', '-z', '--cached'], 'git could not list the tracked files');
  return out
    .split('\0')
    .map((row) => row.trim())
    .filter(Boolean);
}

/**
 * Paths whose worktree copy differs from the index. Only those have to be read
 * out of the index (a process per file); the rest are byte-identical on disk, so
 * a plain read keeps the hook inside its time budget.
 */
function pathsDifferingFromIndex(): Set<string> {
  const out = git(
    ['diff', '--name-only', '-z'],
    'git could not compare the worktree with the index',
  );
  return new Set(
    out
      .split('\0')
      .map((row) => row.trim())
      .filter(Boolean),
  );
}

/** Staged mode reads the index blob, not the worktree copy: a partially staged
 * file must be scanned as it will be committed. */
function readStagedBlob(file: string): ReadResult {
  try {
    const text = execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: failureLines(error).join(' | ') };
  }
}

function readWorktreeFile(file: string): ReadResult {
  try {
    return { ok: true, text: readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

const args = process.argv.slice(2);
const explicit = args.filter((arg) => !arg.startsWith('--'));
const mode =
  explicit.length > 0
    ? 'explicit'
    : args.includes('--staged')
      ? 'staged'
      : args.includes('--tracked')
        ? 'tracked'
        : 'tree';

const files =
  mode === 'explicit'
    ? explicit
    : mode === 'staged'
      ? stagedPaths()
      : mode === 'tracked'
        ? trackedPaths()
        : listFiles(process.cwd()).map((file) => relative(process.cwd(), file));

const dirtyInWorktree =
  mode === 'staged' && files.length > 0 ? pathsDifferingFromIndex() : new Set<string>();

const payloads: Array<{ file: string; text: string }> = [];
const unreadable: string[] = [];
let ignored = 0;

for (const file of files) {
  if (!shouldScanPath(file)) {
    ignored += 1;
    continue;
  }
  // Tracked mode prefers the copy on disk, but a tracked path can be missing from
  // the worktree (a delete that is not staged yet). That is an ordinary working
  // state, so read the committed blob rather than failing the gate closed on it.
  const fromIndex = dirtyInWorktree.has(file) || (mode === 'tracked' && !existsSync(file));
  const result = fromIndex ? readStagedBlob(file) : readWorktreeFile(file);
  if (result.ok) payloads.push({ file, text: result.text });
  else unreadable.push(`${file} — ${result.error}`);
}

if (unreadable.length > 0) {
  abort(
    `${unreadable.length} of ${files.length} file(s) could not be read, so they were never scanned`,
    unreadable,
  );
}

const findings = scanFilesForSecrets(payloads);
if (findings.length > 0) {
  console.error('Secret scanner blocked the commit — a credential pattern matched:');
  for (const row of findings) {
    console.error(`  ${row.file}:${row.line}  ${row.rule}`);
  }
  console.error(
    '  Exit 1 means a real finding. Remove the value (use .env.local or the Integration store),',
  );
  console.error('  then stage the corrected file and commit again.');
  process.exit(EXIT_SECRET_FOUND);
}

// `detect --no-git --source <cwd>` reads the working tree, ignored files included,
// so it belongs to the local-audit mode only. Running it under `--tracked` would
// hand the `verify` gate a permanent red on any machine that has gitleaks
// installed and a populated `.env.local` — a gate nobody can get green is a gate
// that gets deleted. The in-repo rules ran over every tracked file either way.
if (mode === 'tree') {
  try {
    execFileSync('gitleaks', ['detect', '--no-git', '--source', process.cwd()], {
      stdio: 'inherit',
    });
  } catch (error) {
    const failure = error as { status?: number; code?: string };
    if (failure.status === 1) {
      console.error('gitleaks reported findings (listed above).');
      process.exit(EXIT_SECRET_FOUND);
    }
    if (failure.code === 'ENOENT') {
      console.error(
        'gitleaks is not installed — second pass skipped; the in-repo rules still ran.',
      );
    } else {
      abort('gitleaks is installed but did not complete, so its pass proved nothing', [
        'gitleaks detect --no-git',
        ...failureLines(error),
      ]);
    }
  }
}

if (payloads.length === 0) {
  const listed = `${files.length} path(s) listed, ${ignored} ignored by path rules`;
  const headline =
    mode === 'staged'
      ? 'nothing staged to scan'
      : mode === 'explicit'
        ? 'no scannable path was given'
        : mode === 'tracked'
          ? 'git reported no tracked file to scan'
          : 'no scannable file in the working tree';
  console.log(`Secret scan: ${headline} (${listed}). Nothing to scan — this is not a failed scan.`);
  process.exit(0);
}

console.log(`Secret scan passed (${payloads.length} file(s) scanned, ${ignored} ignored).`);
