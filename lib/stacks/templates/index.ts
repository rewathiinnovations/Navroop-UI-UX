import { getDirectionTokens, type DirectionTokens } from '@/lib/design/directions';
import { getStack, type StackId } from '@/lib/stacks';
import { nextjsScaffold } from './nextjs';
import { reactScaffold } from './react';
import { staticHtmlScaffold } from './static-html';
import type { ScaffoldFile } from './shared';

export type { ScaffoldFile } from './shared';
export { staticHtmlIndex } from './static-html';

/**
 * The project files every stack needs to be a runnable repo — package.json,
 * config, entry point, and for NEXTJS/REACT the locked shadcn/ui starter kit.
 *
 * REACT used to be excluded because its scaffold lived inside the sandbox
 * providers' setupViteApp. With the sandboxes gone it lives here like the
 * others, which is what makes an exported React project actually build.
 *
 * `directionId` decides the token block in the global stylesheet, so the same
 * project previews, deploys and exports with one palette. STATIC_HTML ignores
 * it: no build step, no module graph, nowhere for a shared config to live.
 *
 * This is a *repo* builder, and asking for one is expensive in the browser. A
 * module that imports anything from this barrel takes the two scaffold builders,
 * the STATIC_HTML index and the stack definition table with it. `lib/stacks/starter.ts`
 * calls this from the browser preview's graph today and filters the answer down to
 * the starter kit; the runtime half it actually wants is `starterKitFiles` in
 * `./starter-kit`, which reaches neither the scaffold builders nor the stack table.
 * See the pinned graph in `tests/unit/preview-client-graph.test.ts` before adding a
 * caller on the client.
 *
 * The direction lookup is `getDirectionTokens`, never `getDirection(...).tokens`.
 * The scaffolds want nine HSL triplets; the second form reaches `DESIGN_DIRECTIONS`
 * for them, and that record also holds every direction's model instructions, which
 * is how "Minimal is precision, not absence" shipped in the browser preview's
 * bundle. `tests/unit/preview-client-graph.test.ts` bundles that entry and
 * fails on prompt text reappearing in it.
 */
export function getStackScaffold(stack: string, directionId?: string | null): ScaffoldFile[] {
  const definition = getStack(stack);
  return loadScaffold(definition.id, definition.devCommand, getDirectionTokens(directionId));
}

function loadScaffold(
  id: StackId,
  devCommand: string,
  tokens: DirectionTokens,
): ScaffoldFile[] {
  switch (id) {
    case 'NEXTJS':
      return nextjsScaffold(devCommand, tokens);
    case 'REACT':
      return reactScaffold(devCommand, tokens);
    case 'STATIC_HTML':
      return staticHtmlScaffold();
    default: {
      const _exhaustive: never = id;
      throw new Error(`Missing scaffold for "${_exhaustive}"`);
    }
  }
}
