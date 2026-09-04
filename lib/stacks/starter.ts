import { DEFAULT_DESIGN_DIRECTION } from '@/lib/design/directions';
import { getStackScaffold } from '@/lib/stacks/templates';

/**
 * The one merge point for the runtime half of the starter kit.
 *
 * The starter files must *not* be pre-seeded into `Project.lastCode`. A
 * non-empty `lastCode` is the product's evidence that a site exists — in
 * `resumablePhaseFromEvidence` (lib/jobs/resumable-phase.ts), in
 * `duplicateProject`'s `source.lastCode ? 'COMPLETE' : 'PLANNING'`, in the
 * provisional-name check, and in `settleStreamedGeneration`'s `hasSite`. Seed it
 * and every brand-new project reads as finished before a single file is
 * generated.
 *
 * So they are merged at read time instead, underneath the project's own files,
 * at each of the five places a file set becomes something that compiles or
 * ships. A model edit to `app/globals.css` therefore wins over the starter
 * copy, which is what lets a project add a `.dark` block or a font import.
 *
 * Pure and I/O-free on purpose: `assemblePreview` reaches this from
 * `components/workspace/BrowserPreview.tsx`, so it is on the `'use client'`
 * graph and may not touch Prisma, the logger, the settings resolver or a
 * `node:*` builtin (tests/unit/client-import-boundary.test.ts).
 */

/**
 * Scaffold paths a generated app imports at runtime, as opposed to host build
 * config. `package.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config`,
 * `index.html` and the entry points are deliberately absent: they belong to a
 * *repo*, and the preview and the validator compile a file set, not a repo.
 *
 * `tailwind.config.js` is the one build-config file in the list, because the
 * served preview build reads it via the theme injection and the exported repo
 * needs the identical file — leaving it out let the two disagree.
 */
export const STARTER_RUNTIME_PREFIXES: readonly string[] = [
  'app/globals.css',
  'src/index.css',
  'tailwind.config.js',
  'lib/utils.ts',
  'src/lib/utils.ts',
  'components/ui/',
  'src/components/ui/',
  'components/sections/',
  'src/components/sections/',
];

/**
 * Derived from the scaffold rather than restating its content: one source, so
 * the preview cannot compile against a different `button.tsx` than the one the
 * exported repo ships.
 */
export function getStackStarterFiles(
  stack: string,
  directionId?: string | null,
): Record<string, string> {
  // STATIC_HTML has no module graph and no package.json — there is nowhere for
  // components/ui/* or a shared config to live, so it gets none of this.
  if (stack === 'STATIC_HTML') return {};
  const files: Record<string, string> = {};
  for (const file of getStackScaffold(stack, directionId)) {
    if (STARTER_RUNTIME_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
      files[file.path] = file.content;
    }
  }
  return files;
}

/**
 * The starter paths as a sorted list, for the prompt.
 *
 * The model was never told these files exist. They reach the bundler and the
 * validator through `withStarterFiles`, but nothing on the prompt path — and
 * because starter files are deliberately kept out of `Project.lastCode` (see
 * above), a first build hands the model an *empty* file list while `BASE_RULES`
 * tells it to "compose `components/ui/*`, never hand-roll an equivalent". So it
 * re-implemented `Button` and `cn` every time, which is the one instruction the
 * locked stack cannot enforce after the fact.
 *
 * Paths only, never content: the content varies by design direction, the paths
 * do not, so this is a per-stack constant and the cacheable prompt prefix stays
 * byte-identical. `DEFAULT_DESIGN_DIRECTION` is passed for that reason — any
 * direction yields the same keys.
 */
export function starterFilePaths(stack: string): string[] {
  return Object.keys(getStackStarterFiles(stack, DEFAULT_DESIGN_DIRECTION)).sort();
}

/** Starter files underneath, project files on top — a model edit always wins. */
export function withStarterFiles(
  stack: string,
  files: Record<string, string>,
  directionId?: string | null,
): Record<string, string> {
  const starter = getStackStarterFiles(stack, directionId);
  if (Object.keys(starter).length === 0) return files;
  return { ...starter, ...files };
}
