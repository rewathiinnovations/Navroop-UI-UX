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
  /**
   * `assistant` is included because the tool path turns one request into a
   * multi-step conversation and a two-role union would claim otherwise.
   * `buildCachedMessages` still returns exactly the two-element prefix below: the
   * later turns are the SDK's to append, not this function's to invent.
   *
   * `'tool'` is deliberately **not** here, and that is a structural fact rather
   * than a preference. A tool result's `content` in the AI SDK is a structured
   * `ToolContent` array, not a string — so `{ role: 'tool', content: string }` is
   * assignable to no member of `ModelMessage`, and adding it makes this whole
   * alias unassignable at both call sites (`streamText` here and `generateText` in
   * `lib/projects/plan.ts`). A type that has to be cast away at every use is worse
   * than a narrow one.
   *
   * Tool *definitions* travel in `streamText`'s `tools` field rather than in the
   * messages, so they cost the cached prefix nothing.
   */
  role: 'system' | 'user' | 'assistant';
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
