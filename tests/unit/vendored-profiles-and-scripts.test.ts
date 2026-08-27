import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two ways the in-flight generation work left weight behind that nothing reads,
 * both cheap to re-create and neither visible to `tsc`.
 *
 * 1. `lib/ui-ux-pro-max/profiles.ts` is emitted by `scripts/generate-ui-ux-profiles.ts`
 *    from the skill's CSVs. It once carried two exports — `PRODUCT_PROFILES` and a
 *    `UX_RULES: UxRule[]` — that no module ever imported: 4,032 of its 7,716 lines,
 *    about 118 KB, and the second collided by name with the hand-distilled prose bar
 *    `build-design-brief.ts` actually renders, so a reader could not tell which one
 *    the brief printed. A generated file is the easiest place in a repo for dead data
 *    to hide, because "the generator emits it" reads as a reason.
 *
 * 2. `scripts/` collected three self-labelled throwaways (`tmp-authz-snapshot.ts`,
 *    `tmp-f315-probe.mjs`, `tmp-f315-probe2.mjs`) from closed investigations, and
 *    committing them was strictly worse than leaving them untracked: one of the two
 *    probes runs `ALTER TABLE` against whatever database `TEST_DATABASE_URL` names.
 *    Meanwhile the one script that *is* legitimate — a generator whose output is
 *    checked in, and which therefore has no importer by construction — was declared
 *    nowhere, so it read as the dead one.
 */

const PROFILES = 'lib/ui-ux-pro-max/profiles.ts';
const GENERATOR = 'scripts/generate-ui-ux-profiles.ts';

const VALUE_EXPORT = /^export const ([A-Z0-9_]+)\b/gm;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(tsx?|mts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function matchAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

describe('the vendored ui-ux-pro-max profiles carry nothing without a consumer', () => {
  const profiles = readFileSync(PROFILES, 'utf8');
  const exported = matchAll(profiles, VALUE_EXPORT);

  it('still exports the three tables the design brief selects from', () => {
    expect(exported.sort()).toEqual(['LANDING_PROFILES', 'STYLE_PROFILES', 'TYPEFACE_PROFILES']);
  });

  it('exports nothing that no module outside the generated file imports', () => {
    // Bindings taken from *this module*, not names that merely appear somewhere.
    // A bare word search would have called the dead `UX_RULES` export read, because
    // `build-design-brief.ts` declares its own local of that name — the collision
    // that made the dead one hard to see in the first place. Tests are excluded on
    // purpose too: a table whose only reader is an assertion that it exists is
    // exactly the dead weight this guard is about.
    const imported = new Set<string>();
    for (const file of [...sourceFiles('lib'), ...sourceFiles('app'), ...sourceFiles('scripts')]) {
      const rel = relative(process.cwd(), file).split(sep).join('/');
      if (rel === PROFILES) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[2]!;
        if (!/(^|\/)(ui-ux-pro-max\/)?profiles$/.test(specifier)) continue;
        for (const binding of match[1]!.split(',')) {
          const name = binding
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
            .trim();
          if (name) imported.add(name);
        }
      }
    }
    const unread = exported.filter((name) => !imported.has(name));
    expect(unread, `${PROFILES} exports data nothing imports`).toEqual([]);
  });

  it('emits from the generator exactly the exports the file carries', () => {
    // The header says DO NOT EDIT BY HAND, so a hand-trimmed export list would be
    // silently restored by the next run. The generator is the source of the shape.
    const generator = readFileSync(GENERATOR, 'utf8');
    // Only the interpolated form counts: `export const X: T[] = ${…}` inside the
    // emitted template, not a mention of the name in a comment.
    const emitted = matchAll(generator, /\bexport const ([A-Z0-9_]+): \w+\[\] = \$\{/g);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.sort()).toEqual(exported.sort());
  });
});

describe('scripts/ carries no throwaway, and its one generator is declared', () => {
  const names = readdirSync('scripts').filter((name) => statSync(join('scripts', name)).isFile());

  it('finds the scripts to check', () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it('has no file that names itself temporary, by name or in its own header', () => {
    const throwaway = names.filter((name) => {
      if (/^(tmp|temp)[-._]/i.test(name)) return true;
      const header = readFileSync(join('scripts', name), 'utf8').slice(0, 400);
      return /\b(temporary|throwaway|delete[d]? before handoff)\b/i.test(header);
    });
    expect(throwaway, 'a scratch probe was committed to scripts/').toEqual([]);
  });

  it('declares the profile generator as a knip graph root', () => {
    // Its output is checked in, so it has no importer and knip would otherwise
    // report the only thing that can regenerate profiles.ts as dead code.
    const knip = JSON.parse(readFileSync('knip.json', 'utf8')) as { entry: string[] };
    expect(knip.entry).toContain(GENERATOR);
  });
});
