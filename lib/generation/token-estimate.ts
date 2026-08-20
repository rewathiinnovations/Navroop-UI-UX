/** ~4 characters per token. Used when the provider omits usage. */
export const CHARS_PER_TOKEN = 4;

/**
 * The estimate depends only on the length of the text, so a caller assembling a string
 * incrementally can track the length and price a candidate addition without rendering the
 * whole string again (`lib/memory/build-context.ts`).
 */
export function estimateTokensForLength(length: number): number {
  return Math.ceil(length / CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensForLength(text.length);
}

export function readProviderInputTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const raw = record.inputTokens ?? record.promptTokens ?? record.input_tokens;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

export function resolveInputTokens(usage: unknown, fallbackText: string): number {
  return readProviderInputTokens(usage) ?? estimateTokens(fallbackText);
}
