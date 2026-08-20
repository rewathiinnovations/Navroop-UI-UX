import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registeredSuitePaths } from '../setup/suites';

/**
 * The assert-style suites under `tests/*.test.ts` are dynamically imported by
 * `tests/integration/legacy-suites.test.ts` and `legacy-db-suites.test.ts`, so they
 * share one `process.env` with every suite the same worker loads after them. A suite
 * that sets a variable and walks away decides the environment for its successors.
 *
 * F-617: `tests/github-oauth.test.ts` set `AUTH_SECRET` at module scope with no
 * restore. It fired only when no AUTH_SECRET / NEXTAUTH_SECRET / ENCRYPTION_KEY was
 * present — i.e. on CI, not on a developer box — which is exactly the shape of leak
 * that makes a later auth test pass or fail on load order. Every other suite already
 * saved and restored; this pins the rule for all of them.
 *
 * The rule is mechanical: a variable a suite mutates has to be mutated at least twice
 * in the same file — once to set it and once to put it back (`delete process.env.X`,
 * or an assignment from the saved value). One lone mutation is a leak.
 */

const SETUP_DIR = fileURLToPath(new URL('../setup/', import.meta.url));
const MUTATION = /(?:delete\s+process\.env\.([A-Z0-9_]+))|(?:process\.env\.([A-Z0-9_]+)\s*=)/g;

function mutationCounts(source: string) {
  const counts = new Map<string, number>();
  for (const match of source.matchAll(MUTATION)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

describe('no registered legacy suite leaks process.env to the suites after it', () => {
  const suites = registeredSuitePaths();

  it('reads every registered suite', () => {
    // Anti-vacuity: an empty registry would satisfy the per-suite case below.
    expect(suites.length).toBeGreaterThan(20);
  });

  for (const relative of suites) {
    const path = fileURLToPath(new URL(relative, `file://${SETUP_DIR.replace(/\\/g, '/')}`));
    it(`${relative} restores everything it mutates`, () => {
      const counts = mutationCounts(readFileSync(path, 'utf8'));
      const unrestored = [...counts.entries()]
        .filter(([, count]) => count < 2)
        .map(([name]) => name);
      expect(
        unrestored,
        `${relative} mutates ${unrestored.join(', ')} once and never puts it back. ` +
          'Save the previous value and restore it (or delete it) in a finally, the way ' +
          'tests/backup.test.ts and tests/unit/api-route-auth.test.ts do.',
      ).toEqual([]);
    });
  }
});
