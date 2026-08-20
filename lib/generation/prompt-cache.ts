/**
 * Prompt-cache layout:
 *   1. system = STABLE prefix (base-rules + seo-rules + Brain memory + stack + design direction)
 *      — byte-identical for the same stack + direction + ACTIVE memory set.
 *      Skills are conditional and must stay in the volatile user message, not here.
 *   2. user   = VOLATILE (skills if matched, conversation, brief, files, user message) — last.
 *
 * OpenAI automatic prefix cache hits when this system block is unchanged.
 * There is no explicit cache-control marker to set: DeepSeek is the only
 * provider (lib/ai/providers.ts), it speaks the OpenAI wire format, and its
 * prefix cache is automatic. An `enableAnthropicCache` flag lived here until
 * 2026-08-20; every one of its three call sites derived it from a value that
 * could never start with `anthropic/`, so the branch was dead (F-737).
 */

export type CachedGenerationMessage = {
  role: 'system' | 'user';
  content: string;
};

export function buildCachedMessages(input: {
  stablePrefix: string;
  volatileUser: string;
}): CachedGenerationMessage[] {
  return [
    { role: 'system', content: input.stablePrefix },
    { role: 'user', content: input.volatileUser },
  ];
}
