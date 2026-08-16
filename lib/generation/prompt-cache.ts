/**
 * Prompt-cache layout:
 *   1. system = STABLE prefix (base-rules + seo-rules + Brain memory + stack + design direction)
 *      — byte-identical for the same stack + direction + ACTIVE memory set.
 *      Skills are conditional and must stay in the volatile user message, not here.
 *   2. user   = VOLATILE (skills if matched, conversation, brief, files, user message) — last.
 *
 * OpenAI automatic prefix cache hits when this system block is unchanged.
 */

export type CachedGenerationMessage = {
  role: 'system' | 'user';
  content: string;
  providerOptions?: {
    anthropic: { cacheControl: { type: 'ephemeral' } };
  };
};

export function buildCachedMessages(input: {
  stablePrefix: string;
  volatileUser: string;
  enableAnthropicCache?: boolean;
}): CachedGenerationMessage[] {
  const system: CachedGenerationMessage = {
    role: 'system',
    content: input.stablePrefix,
  };
  if (input.enableAnthropicCache) {
    system.providerOptions = {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    };
  }
  return [system, { role: 'user', content: input.volatileUser }];
}
