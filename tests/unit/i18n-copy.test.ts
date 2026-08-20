import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNonEnglishUserCopy } from '../../lib/i18n/user-copy';

/**
 * There is no translation catalog, so shipped copy must be English and must not
 * carry the banned brand word. `lib/i18n/user-copy.ts` explains both rules.
 *
 * F-768: the scan covered `app/` and `components/` only, while a large share of
 * user-facing strings now live in `lib/` — `lib/jobs/copy.ts`, the import and
 * url-guard message tables, `lib/templates`, `lib/publish` — none of which were
 * being checked. The guard module itself is skipped: it is the one file that has
 * to contain the pattern.
 */

const ROOTS = ['app', 'components', 'lib'];
const GUARD_MODULE = join('lib', 'i18n', 'user-copy.ts');

function walk(dir: string, acc: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('i18n sanity (no catalog)', () => {
  it('user-facing app, component and lib strings contain no Hindi and no klarco', () => {
    const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root)));
    // The scan is worthless if the roots move and it silently walks nothing.
    expect(files.length).toBeGreaterThan(500);

    const hits: string[] = [];
    for (const file of files) {
      if (relative(process.cwd(), file) === GUARD_MODULE) continue;
      const found = findNonEnglishUserCopy(readFileSync(file, 'utf8'));
      if (found.length)
        hits.push(`${relative(process.cwd(), file).split(sep).join('/')}: ${found.join(',')}`);
    }
    expect(hits).toEqual([]);
  });

  it('detects both rules, so an empty result means clean and not a broken matcher', () => {
    expect(findNonEnglishUserCopy('Publish your site')).toEqual([]);
    expect(findNonEnglishUserCopy('प्रकाशित करें')).toEqual(['hindi']);
    expect(findNonEnglishUserCopy('Built with Klarco')).toEqual(['klarco']);
    expect(findNonEnglishUserCopy('klarco प्रकाशित')).toEqual(['hindi', 'klarco']);
    // A substring must not trip it — the rule is the word, not the letters.
    expect(findNonEnglishUserCopy('klarcorp')).toEqual([]);
  });
});
