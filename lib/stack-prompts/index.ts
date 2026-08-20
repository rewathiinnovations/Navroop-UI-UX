import { getDirection, toPromptBlock } from '@/lib/design/directions';
import { getStack, isStackId, type StackId } from '@/lib/stacks';
import { BASE_RULES } from './base-rules';
import { buildNextjsStablePrompt } from './nextjs';
import { buildReactStablePrompt } from './react';
import { buildStaticHtmlStablePrompt } from './static-html';
import { COMPLETION_RULES, buildVolatilePromptSuffix, type StackPromptContext } from './shared';
import { getSeoRules } from './seo-rules';

export type { StackPromptContext } from './shared';
export { buildVolatilePromptSuffix } from './shared';
export { BASE_RULES } from './base-rules';
export { getSeoRules } from './seo-rules';

type StableBuilder = () => string;

const STACK_STABLE: Record<StackId, StableBuilder> = {
  NEXTJS: buildNextjsStablePrompt,
  REACT: buildReactStablePrompt,
  STATIC_HTML: buildStaticHtmlStablePrompt,
};

export type StablePromptExtras = {
  /** ACTIVE workspace + project Brain memory. Inside the cacheable prefix. Not skills. */
  memoryBlock?: string | null;
};

/**
 * Byte-identical for the same stack + direction + memory set.
 * Order is fixed: base-rules → seo-rules → memory → design direction → stack → completion.
 * Skills stay outside this prefix.
 */
export function buildStablePromptPrefix(
  stack: string,
  directionId?: string | null,
  extras?: StablePromptExtras,
): string {
  if (!isStackId(stack)) {
    throw new Error(`Missing stack prompt for "${stack}" — not a known stack`);
  }
  getStack(stack);
  const builder = STACK_STABLE[stack];
  if (!builder) {
    throw new Error(`Missing stack prompt for "${stack}"`);
  }
  const stackBody = builder();
  if (!stackBody || !stackBody.trim()) {
    throw new Error(`Empty stack prompt for "${stack}"`);
  }
  if (stack !== 'REACT' && /You are an expert React developer/.test(stackBody)) {
    throw new Error(`Stack prompt for "${stack}" incorrectly used the React prompt`);
  }
  const memory = extras?.memoryBlock?.trim();
  return [
    BASE_RULES,
    getSeoRules(stack),
    memory,
    toPromptBlock(getDirection(directionId)),
    stackBody,
    getStackInitialPackageRule(stack),
    COMPLETION_RULES,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n\n');
}

/**
 * Look up the system prompt for a stack + design direction.
 * Throws if the stack id is unknown or the prompt builder is missing.
 * Never silently falls through to the React prompt for a non-REACT stack.
 */
export function getStackPrompt(
  stack: string,
  directionId?: string | null,
  ctx?: StackPromptContext,
  extras?: StablePromptExtras,
): string {
  const stable = buildStablePromptPrefix(stack, directionId, extras);
  const volatile = buildVolatilePromptSuffix(ctx);
  return volatile ? `${stable}\n\n${volatile}` : stable;
}

export function getStackInitialPackageRule(stack: string): string {
  switch (getStack(stack).id) {
    case 'REACT':
      return 'For INITIAL generation: Use ONLY React, no external packages';
    case 'NEXTJS':
      return 'For INITIAL generation: Use ONLY Next.js and React, no unexpected external packages';
    case 'STATIC_HTML':
      return 'For INITIAL generation: Use ONLY HTML, vanilla JS, and Tailwind CDN — no npm packages';
    default: {
      const id = getStack(stack).id;
      throw new Error(`Missing initial-package rule for "${id}"`);
    }
  }
}
