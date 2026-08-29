import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/sections';

/**
 * One reading of "which sections does this file import", shared by the two gates.
 *
 * There were two regexes. `write-guard.ts` matched `from '…/sections/<name>'` allowing dots,
 * so it blessed `hero.tsx`; `quality-check.ts` matched `[a-z0-9-]+`, so it could not see past
 * the dot and reported the same file as missing the section it had just imported. A file the
 * persist gate allowed was failed by the quality gate seconds later, and the repair asked the
 * model to add a section the page already rendered.
 *
 * Both misses were the same bug — two copies of one rule, drifting — so the rule lives here
 * and the writable set and the countable set are now the same set by construction.
 *
 * Matching is on the *specifier*, not on the `from` keyword, because the keyword is the part
 * that varies: `next/dynamic` around a below-the-fold section is idiomatic and writes
 * `import('@/components/sections/faq')` with no `from` at all, and a side-effect import and a
 * `require` have none either. All three used to walk straight through the guard.
 *
 * Pure and dependency-free on purpose: `quality-check.ts` runs inside the generation route on
 * every build and `write-guard.ts` is on the write path, so neither may pull in zod or the
 * registry. The names come from the same constant the starter kit emits files from.
 */

export const KNOWN_SECTION_NAMES: ReadonlySet<string> = new Set(SECTION_COMPONENT_NAMES);

/**
 * Any specifier that points into the sections directory, aliased or relative.
 *
 * The alias is what the prompt teaches and what the kit's own files use, but a relative
 * `../../components/sections/hero` resolves to the identical file and used to be invisible to
 * both gates.
 */
const SECTION_SPECIFIER = /['"]([^'"]*components\/sections(?:\/[^'"]*)?)['"]/g;

const SOURCE_EXTENSION = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

export type SectionImports = {
  /** Section names the file imports, restricted to ones the kit actually ships. */
  names: Set<string>;
  /** Names that look like a section import but match nothing the kit ships. */
  unknown: string[];
  /**
   * The file imports the directory itself (`from '@/components/sections'`).
   *
   * The kit ships no `index.ts` there, so this resolves to nothing — but it also means the
   * set of sections the file uses cannot be read off its specifiers, which is why the
   * section checker treats it as "unknowable" rather than as "none".
   */
  barrel: boolean;
};

export function sectionImportsIn(source: string): SectionImports {
  const names = new Set<string>();
  const unknown: string[] = [];
  let barrel = false;

  SECTION_SPECIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECTION_SPECIFIER.exec(source)) !== null) {
    const specifier = match[1];
    const after = specifier.split('components/sections')[1] ?? '';
    const subpath = after.replace(/^\//, '').trim();
    if (subpath === '') {
      barrel = true;
      continue;
    }
    // `marketing/carousel` is not the `marketing` section: the first segment is the file, and
    // anything below it is a path the kit does not have.
    const [head, ...rest] = subpath.split('/');
    const name = head.replace(SOURCE_EXTENSION, '');
    if (rest.length === 0 && KNOWN_SECTION_NAMES.has(name)) names.add(name);
    else if (!unknown.includes(name)) unknown.push(name);
  }

  return { names, unknown, barrel };
}

/**
 * Sections the build prompt puts in the layout, not in a page.
 *
 * `base-rules` says "Shared chrome (nav, footer) lives in layout.tsx" and the Next rules
 * repeat it, so a model that obeys the prompt exactly renders the footer once in
 * `app/layout.tsx`. The section checker reads `app/**` + `/page.tsx` only, so it saw a page
 * that did not import `site-footer` and reported a thin page — on every page of a six-page
 * plan, each one costing a repair generation that would paste a second footer under the one
 * the layout already renders.
 *
 * Two guards, and this is the second: the checker unions the ancestor layouts' imports, and
 * these names are kept out of what the planner is offered in the first place, so a stored
 * plan cannot promise them per page.
 */
export const LAYOUT_OWNED_SECTIONS: ReadonlySet<string> = new Set(['site-footer']);

/** The catalogue a page may be planned against — everything the layout does not own. */
export function pageSectionNames(): string[] {
  return SECTION_COMPONENT_NAMES.filter((name) => !LAYOUT_OWNED_SECTIONS.has(name));
}
