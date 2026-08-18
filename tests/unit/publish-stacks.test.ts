import { describe, expect, it } from 'vitest';
import { getStack, STACK_IDS } from '../../lib/stacks';

describe('publish stack build config', () => {
  it('every stack build command comes from lib/stacks.ts', () => {
    for (const id of STACK_IDS) {
      const stack = getStack(id);
      expect(stack.id).toBe(id);
      if (stack.deployType === 'static') {
        expect(stack.buildCommand === null || typeof stack.buildCommand === 'string').toBe(true);
      }
      if (stack.deployType === 'node') {
        expect(stack.startCommand).toBeTruthy();
      }
    }
  });
});
