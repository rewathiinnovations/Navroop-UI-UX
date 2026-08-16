/** ~4 characters per token. Used when the provider omits usage. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
