import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `lib/jobs/store.ts` carries three exclusion primitives that nothing calls.
 *
 * That on its own is cheap. What is not cheap is what their docstrings said while it was
 * true: `claimScanAttempt`'s opened "The bound on unmetered scans was … So the row goes in
 * first and the caller settles it afterwards", in the past tense of a fix that had landed.
 * It had not. The bound that ships is still the shape that comment calls broken — a warrant
 * check, a module-local `Map`, and an AUDIT row written *after* the scan returns — so it
 * bounds replays that arrive after a run, never two runs at once. It costs nothing today
 * only because the automatic path runs at depth `'static'` and calls no provider. The next
 * agent to read that comment would conclude the durable claim was in place, and restoring
 * the AI review to that path on the strength of it would restore exactly the double billing
 * the comment describes in the past tense.
 *
 * So this guard is about the agreement between the two, in both directions. A primitive with
 * no caller must say so in the words a reader will see first; a primitive that gains one must
 * lose that sentence in the same change, or the comment is lying the other way round. It
 * cannot be satisfied by a comment alone and it cannot be satisfied by wiring alone.
 *
 * The marker is a phrase rather than a tag because the phrase is what a person reads. Keep it
 * inside the doc block that sits immediately above the export.
 */

/** The exact words a doc block must carry while nothing in production calls the export. */
const UNWIRED_MARKER = 'no production caller';

/**
 * The exports whose docstrings have to track their callers.
 *
 * All three describe an exclusion that only holds if something takes it: a reserved scan
 * attempt, a kind-scoped liveness test, a stamped AUDIT row. A reader who believes any of
 * them is live builds on a guarantee the process does not have.
 */
const CLAIM_EXPORTS = ['claimScanAttempt', 'getActiveJobOfKinds', 'claimAuditJobStep'] as const;

/** Where a real caller would live. Tests are deliberately not in this set — see below. */
const PRODUCTION_ROOTS = ['app', 'lib', 'components', 'scripts'] as const;

const STORE_FILE = join('lib', 'jobs', 'store.ts');
const SOURCE_EXT = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', 'coverage', '.git']);

function sourceFilesUnder(root: string, cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXT.some((ext) => entry.endsWith(ext))) out.push(full);
    }
  };
  walk(join(cwd, root));
  return out;
}

/**
 * The doc block immediately above an export, or `null` if it has none.
 *
 * Anchored on the `export` keyword rather than on the identifier so a mention of the name
 * inside some other comment cannot be mistaken for its documentation.
 */
function docBlockFor(source: string, name: string): string | null {
  const declaration = new RegExp(`^export (?:async )?function ${name}\\b`, 'm').exec(source);
  if (!declaration) return null;
  const before = source.slice(0, declaration.index);
  const open = before.lastIndexOf('/**');
  const close = before.lastIndexOf('*/');
  if (open === -1 || close === -1 || close < open) return null;
  // Anything but whitespace between the block and the export means the block documents
  // something else.
  if (before.slice(close + 2).trim() !== '') return null;
  return before.slice(open, close + 2);
}

/** Files outside `lib/jobs/store.ts` that name the identifier at all. */
function productionCallersOf(name: string, cwd: string): string[] {
  const word = new RegExp(`\\b${name}\\b`);
  const hits: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of sourceFilesUnder(root, cwd)) {
      const rel = relative(cwd, file);
      if (rel === STORE_FILE) continue;
      if (word.test(readFileSync(file, 'utf8'))) hits.push(rel.split(sep).join('/'));
    }
  }
  return hits;
}

describe('the job store documents which of its claims are actually wired', () => {
  const cwd = process.cwd();
  const store = readFileSync(join(cwd, STORE_FILE), 'utf8');

  it.each(CLAIM_EXPORTS)('%s says whether production calls it, and is right', (name) => {
    const doc = docBlockFor(store, name);
    if (doc === null) throw new Error(`${name} has no doc block above its export`);

    const callers = productionCallersOf(name, cwd);
    const claimsUnwired = doc.includes(UNWIRED_MARKER);

    if (callers.length === 0) {
      expect(
        claimsUnwired,
        `${name} has no production caller, so its doc block must say "${UNWIRED_MARKER}" — ` +
          `a comment describing a durable claim nobody takes is how the next agent builds on ` +
          `a guarantee this process does not have`,
      ).toBe(true);
    } else {
      expect(
        claimsUnwired,
        `${name} is now called from ${callers.join(', ')}, so its doc block must stop saying ` +
          `"${UNWIRED_MARKER}"`,
      ).toBe(false);
    }
  });

  /**
   * A scanner that finds nothing anywhere would pass the three cases above by accident, and
   * would keep passing after the claim was wired in — the exact failure this file exists to
   * catch, inverted. `insertSettledJob` is the wired twin: both quality scans call it from
   * `recordScanRun`, and it is what `claimScanAttempt` would sit in front of. So it has
   * callers, and its doc block must not carry the marker.
   *
   * The test suite is not a caller. `tests/unit/job-store-claims-and-lookups.test.ts`
   * exercises all three unwired exports against a mocked Prisma, which is why the tree greps
   * clean for "unused" and why the divergence survived five rounds: each has a green test
   * proving the SQL it emits is correct, and none of that SQL ever runs.
   */
  it('finds the callers of a wired export, so an empty answer means something', () => {
    const callers = productionCallersOf('insertSettledJob', cwd);
    expect(callers).toContain('lib/audit/actions.ts');
    expect(callers).toContain('lib/seo/actions.ts');

    const doc = docBlockFor(store, 'insertSettledJob');
    if (doc === null) throw new Error('insertSettledJob has no doc block above its export');
    expect(doc).not.toContain(UNWIRED_MARKER);
  });
});
