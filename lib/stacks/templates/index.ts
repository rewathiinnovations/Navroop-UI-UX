import { getStack, type StackId } from '@/lib/stacks';
import { nextjsScaffold } from './nextjs';
import { staticHtmlScaffold } from './static-html';
import type { ScaffoldFile } from './shared';

export type { ScaffoldFile } from './shared';
export { staticHtmlIndex } from './static-html';

/**
 * Deterministic sandbox files for non-REACT stacks.
 * REACT stays on the existing provider Vite/React path — do not call this for REACT.
 */
export function getStackScaffold(stack: string): ScaffoldFile[] {
  const definition = getStack(stack);
  if (definition.id === 'REACT') {
    throw new Error(
      'REACT scaffold is owned by provider setupViteApp — do not use getStackScaffold',
    );
  }
  return loadScaffold(definition.id, definition.devCommand);
}

function loadScaffold(id: Exclude<StackId, 'REACT'>, devCommand: string): ScaffoldFile[] {
  switch (id) {
    case 'NEXTJS':
      return nextjsScaffold(devCommand);
    case 'STATIC_HTML':
      return staticHtmlScaffold();
    default: {
      const _exhaustive: never = id;
      throw new Error(`Missing scaffold for "${_exhaustive}"`);
    }
  }
}
