import { getStack, type StackId } from '@/lib/stacks';
import { nextjsScaffold } from './nextjs';
import { reactScaffold } from './react';
import { staticHtmlScaffold } from './static-html';
import type { ScaffoldFile } from './shared';

export type { ScaffoldFile } from './shared';
export { staticHtmlIndex } from './static-html';

/**
 * The project files every stack needs to be a runnable repo — package.json,
 * config, entry point. Generated components sit on top of these.
 *
 * REACT used to be excluded because its scaffold lived inside the sandbox
 * providers' setupViteApp. With the sandboxes gone it lives here like the
 * others, which is what makes an exported React project actually build.
 */
export function getStackScaffold(stack: string): ScaffoldFile[] {
  const definition = getStack(stack);
  return loadScaffold(definition.id, definition.devCommand);
}

function loadScaffold(id: StackId, devCommand: string): ScaffoldFile[] {
  switch (id) {
    case 'NEXTJS':
      return nextjsScaffold(devCommand);
    case 'REACT':
      return reactScaffold(devCommand);
    case 'STATIC_HTML':
      return staticHtmlScaffold();
    default: {
      const _exhaustive: never = id;
      throw new Error(`Missing scaffold for "${_exhaustive}"`);
    }
  }
}
