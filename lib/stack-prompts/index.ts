import { getStack, isStackId, type StackId } from '@/lib/stacks';
import { buildAstroSystemPrompt } from './astro';
import { buildNextjsSystemPrompt } from './nextjs';
import { buildReactSystemPrompt } from './react';
import { buildStaticHtmlSystemPrompt } from './static-html';
import { buildSvelteSystemPrompt } from './svelte';
import { buildVueSystemPrompt } from './vue';
import type { StackPromptContext } from './shared';

export type { StackPromptContext, StackPromptEditContext } from './shared';

type PromptBuilder = (ctx: StackPromptContext) => string;

const STACK_PROMPTS: Record<StackId, PromptBuilder> = {
  NEXTJS: buildNextjsSystemPrompt,
  REACT: buildReactSystemPrompt,
  ASTRO: buildAstroSystemPrompt,
  STATIC_HTML: buildStaticHtmlSystemPrompt,
  VUE: buildVueSystemPrompt,
  SVELTE: buildSvelteSystemPrompt,
};

/**
 * Look up the system prompt for a stack.
 * Throws if the stack id is unknown or the prompt builder is missing.
 * Never silently falls through to the React prompt for a non-REACT stack.
 */
export function getStackPrompt(stack: string, ctx: StackPromptContext): string {
  if (!isStackId(stack)) {
    throw new Error(`Missing stack prompt for "${stack}" — not a known stack`);
  }
  // Validate the registry entry exists (throws on holes).
  getStack(stack);
  const builder = STACK_PROMPTS[stack];
  if (!builder) {
    throw new Error(`Missing stack prompt for "${stack}"`);
  }
  const prompt = builder(ctx);
  if (!prompt || !prompt.trim()) {
    throw new Error(`Empty stack prompt for "${stack}"`);
  }
  if (stack !== 'REACT' && prompt.startsWith('You are an expert React developer')) {
    throw new Error(`Stack prompt for "${stack}" incorrectly used the React prompt`);
  }
  return prompt;
}

export function getStackInitialPackageRule(stack: string): string {
  switch (getStack(stack).id) {
    case 'REACT':
      return 'For INITIAL generation: Use ONLY React, no external packages';
    case 'NEXTJS':
      return 'For INITIAL generation: Use ONLY Next.js and React, no unexpected external packages';
    case 'ASTRO':
      return 'For INITIAL generation: Use ONLY Astro (and islands when needed), no unexpected external packages';
    case 'STATIC_HTML':
      return 'For INITIAL generation: Use ONLY HTML, vanilla JS, and Tailwind CDN — no npm packages';
    case 'VUE':
      return 'For INITIAL generation: Use ONLY Vue 3, no unexpected external packages';
    case 'SVELTE':
      return 'For INITIAL generation: Use ONLY Svelte/SvelteKit, no unexpected external packages';
    default: {
      const id = getStack(stack).id;
      throw new Error(`Missing initial-package rule for "${id}"`);
    }
  }
}
