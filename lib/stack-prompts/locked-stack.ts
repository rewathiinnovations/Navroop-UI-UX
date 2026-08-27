import { OPTIONAL_PREVIEW_DEPS, PREVIEW_DEPS } from '@/lib/preview/deps';
import { starterFilePaths } from '@/lib/stacks/starter';
import { UI_COMPONENT_NAMES } from '@/lib/stacks/templates/starter-kit';

/**
 * The prompt's half of the locked stack.
 *
 * Generated from `PREVIEW_DEPS` and the starter kit's own component list rather
 * than written out, because a prompt that names a package the import map does
 * not serve produces code that compiles and then dies in the iframe with "The
 * preview could not load one of its packages" — and a prompt that omits one the
 * project ships makes the model hand-roll a primitive it already has.
 *
 * `srcPrefix` is `''` for NEXTJS and `'src/'` for REACT, which is the only
 * difference between the two stacks' copies of this block.
 */
export function lockedStackRule(srcPrefix: string): string {
  const ui = `${srcPrefix}components/ui`;
  return `LOCKED STACK (already in the project — never recreate these files):
- ${srcPrefix}lib/utils.ts exports cn(). Use it for every conditional className.
- ${ui}/ holds shadcn/ui primitives: ${UI_COMPONENT_NAMES.join(', ')}. Import them as @/components/ui/<name> and compose them. They are meant to be customized: to give one a new look, add a cva variant inside its own file and use it by name. Never hand-roll your own Button, Card or Dialog beside them.
- tailwind.config.js and the global stylesheet exist and define the palette, the gradients and the shadows. Do not recreate either; to add a colour, add the CSS variable to the token block in the global stylesheet (HSL triplet, no wrapper) and extend the config.
- Icons come from lucide-react. Never inline an SVG icon set.
- Do not create package.json, tsconfig.json, postcss.config.js or the Tailwind config — they exist.`;
}

/**
 * The exact set the preview import map resolves, sorted so the prompt is stable.
 *
 * Two tiers, because they are two different actions for the model: the first list
 * is importable now, the second needs an `add_dependency` call first. Generated
 * from the constants so the prompt cannot name a package the import map does not
 * serve — an import of one of those compiles and then dies in the iframe.
 */
export function availablePackagesRule(): string {
  return `AVAILABLE PACKAGES (nothing else resolves — an import of anything not listed here fails the build):
- ${Object.keys(PREVIEW_DEPS).sort().join(', ')}

AVAILABLE ON REQUEST (call add_dependency first, then import):
- ${Object.keys(OPTIONAL_PREVIEW_DEPS).sort().join(', ')}`;
}

/**
 * The starter files by exact path, as opposed to `lockedStackRule`'s prose.
 *
 * `lockedStackRule` names the directory and the component list; this names the
 * files. The difference matters twice. On a first build the file list handed to
 * the model is *empty* — starter files are deliberately kept out of
 * `Project.lastCode`, because a non-empty `lastCode` is the product's evidence
 * that a site exists — so "compose components/ui/*" described a directory the
 * model had been shown no trace of, and it re-implemented `Button` and `cn`. And
 * on the tool path an exact path is what `read_file` / `edit_file` need: a
 * guessed `components/ui/Button.tsx` is a miss and a wasted step.
 *
 * In the stable prefix, not in the route's per-request first-generation block:
 * the prefix is keyed by (stack, direction, memory, outputMode) and not by
 * `isEdit`, so making this conditional on a first build would split the cache —
 * and the primitives exist on an edit just as much.
 *
 * Returns '' for STATIC_HTML, which ships no starter kit by design.
 */
export function starterFilesRule(stack: string): string {
  const paths = starterFilePaths(stack);
  if (paths.length === 0) return '';
  return `ALREADY IN THE PROJECT (these exact files exist — import them, never recreate them):
${paths.map((path) => `- ${path}`).join('\n')}`;
}
