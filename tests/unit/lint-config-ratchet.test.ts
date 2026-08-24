import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-790 and F-791. The gate looked strict — `eslint . --max-warnings 0` plus a knip
 * step — while the rules that would have found this repository's dead code were `off`
 * and knip was told to ignore the three directories holding most of it. Neither was a
 * deliberate trade-off recorded anywhere; both were just `off`, and nothing failed
 * when they were.
 *
 * So the re-enabling is pinned here. Flipping a rule back to `off`, or re-adding
 * `scripts/**` / `tests/**` / `e2e/**` to knip's ignore list, now fails a test
 * instead of quietly restoring the blindness.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');

const eslintConfigSource = readFileSync(join(repoRoot, 'eslint.config.mjs'), 'utf8');
const knipConfig = JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf8')) as {
  ignore: string[];
  entry: string[];
};

/**
 * Rules that were `off` before Waves 4 and 6 and are now enforced everywhere, with no
 * sanctioned exemption. Each was measured to zero violations (or had its violations
 * fixed) before being flipped, so a re-disable is a regression, not a cleanup.
 */
const MUST_BE_ENFORCED_EVERYWHERE = [
  '@typescript-eslint/no-unused-vars',
  'no-empty',
  'prefer-const',
  'react/no-unescaped-entities',
];

function disabledPattern(rule: string) {
  // Matches `'rule': 'off'` and `'rule': ['off', …]`, which is how every entry in
  // this config is written.
  return new RegExp(`'${rule.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\[?'off'`, 'g');
}

describe('the re-enabled ESLint rules stay enabled', () => {
  for (const rule of MUST_BE_ENFORCED_EVERYWHERE) {
    it(`${rule} is not set back to off anywhere in the config`, () => {
      expect(eslintConfigSource).not.toMatch(disabledPattern(rule));
      expect(eslintConfigSource).toContain(`'${rule}'`);
    });
  }

  it('no-explicit-any is an error with no exemption anywhere', () => {
    expect(eslintConfigSource).toMatch(/'@typescript-eslint\/no-explicit-any':\s*'error'/);
    // This used to permit exactly one `off`, scoped to an ANY_UNREACHABLE allowlist of
    // nine importerless PixiJS/marketing modules. Deleting F-448's unreachable tree took
    // all nine, so the exemption they justified is gone and the count is now zero. The
    // assertion tightened rather than being deleted: a reintroduced `off` is a new hole
    // whether or not anyone writes an allowlist around it.
    const offs = eslintConfigSource.match(disabledPattern('@typescript-eslint/no-explicit-any'));
    expect(offs).toBeNull();
    expect(eslintConfigSource).not.toContain('ANY_UNREACHABLE');
  });
});

/**
 * `no-explicit-any` used to have one hole: nine modules with no importer, whose `any`s
 * wrapped untyped PixiJS internals. It was a list rather than a blanket `off` precisely
 * so it could only shrink — and it shrank to nothing when F-448's unreachable tree was
 * deleted, because every path in it lived there.
 *
 * What that leaves is stronger than the old pair of tests: not "the allowlist has not
 * been widened" but "there is no `any` in first-party source at all". The scan stays
 * because that is the claim `--max-warnings 0` makes and this is what checks it against
 * the tree rather than against the config.
 */
describe('no first-party source declares an `any`', () => {
  it('finds source files to scan', () => {
    // Guards the scan itself: a walk that silently matched nothing would make the
    // assertion below pass for the wrong reason.
    expect(readdirSync(repoRoot).length).toBeGreaterThan(10);
  });

  it('reports no file carrying an explicit any', () => {
    expect(sourceFilesWithExplicitAny()).toEqual([]);
  });
});

describe('knip is not blinded to the directories that held the dead code', () => {
  it('does not ignore scripts, tests or e2e', () => {
    for (const blinded of ['scripts/**', 'tests/**', 'e2e/**']) {
      expect(knipConfig.ignore).not.toContain(blinded);
    }
  });

  it('declares the suites that only a runner enters, so they are not false positives', () => {
    // `tests/*.test.ts` are loaded by path string through the registry in
    // `tests/setup/suites.ts`, and the two setup files by `vitest.config.ts`.
    // Without these entries knip reports all 39 as unused and the report is noise.
    expect(knipConfig.entry).toContain('tests/*.test.ts');
    expect(knipConfig.entry).toContain('tests/setup/vitest.setup.ts');
    expect(knipConfig.entry).toContain('tests/setup/repo-write-guard.global.ts');
  });
});

/**
 * Directories ESLint itself ignores, plus build output, caches, and the two trees
 * whose `any` is not this rule's business (`tests/`, `e2e/`). Static membership
 * table, so a `Record` rather than a `Set`.
 */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  '.git': true,
  '.next': true,
  '.worktrees': true,
  '.claude': true,
  '.cursor': true,
  coverage: true,
  'playwright-report': true,
  'test-results': true,
  generated: true,
  examples: true,
  out: true,
  build: true,
  dist: true,
  '.data': true,
  public: true,
  tests: true,
  e2e: true,
};

const SOURCE_FILE = /\.tsx?$/;

/**
 * Declarations of `any` in first-party source, as repo-relative POSIX paths.
 *
 * Deliberately a text scan and not an ESLint run: this suite must not shell out to
 * the linter it is checking, and a repo-wide lint takes ~20s. `: any`, `<any>`,
 * `as any` and `any[]` are the four shapes the rule reports.
 *
 * Comments and template literals are stripped first. Template literals matter:
 * `lib/preview/assemble.ts` emits `next/link` and `next/image` shims as generated
 * *source text*, so `({ href, children, ...rest }: any)` appears inside a backtick
 * string. That is not a type annotation in this file, ESLint rightly ignores it, and
 * a scan that did not would report a file with nothing to fix.
 */
function sourceFilesWithExplicitAny(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS[name] || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_FILE.test(name)) continue;
      // Template literals come off FIRST. Stripping `//` comments first can remove a
      // `//` that lives *inside* a template literal (a URL in generated source), which
      // unbalances the backtick pairing and lets the next literal's body survive —
      // verified against `lib/preview/assemble.ts`, whose emitted next/* shims then
      // read as two `any` annotations in this file.
      const code = readFileSync(full, 'utf8')
        .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/(:\s*any\b)|(<any>)|(\bas any\b)|(\bany\[\])/.test(code)) {
        found.push(relative(repoRoot, full).split(sep).join(posix.sep));
      }
    }
  };
  walk(repoRoot);
  return found.sort();
}
