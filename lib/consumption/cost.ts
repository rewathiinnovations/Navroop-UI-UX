import {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
  type GenerationEventKind,
} from '@/lib/usage-estimates';

export type TokenCostInput = {
  tokensIn?: number | null;
  tokensOut?: number | null;
  provider?: string | null;
  model?: string | null;
};

type Rate = { input: number; output: number };

const PER_MILLION: Record<string, Rate> = {
  groq: { input: 0.1, output: 0.1 },
  openai: { input: 0.15, output: 0.6 },
  anthropic: { input: 3, output: 15 },
  google: { input: 0.1, output: 0.4 },
  default: { input: 0.15, output: 0.6 },
};

function ratesFor(provider?: string | null, model?: string | null): Rate {
  const key = (provider || model || '').toLowerCase();
  if (key.includes('groq') || key.includes('kimi') || key.includes('moonshot'))
    return PER_MILLION.groq;
  if (key.includes('anthropic') || key.includes('claude')) return PER_MILLION.anthropic;
  if (key.includes('google') || key.includes('gemini')) return PER_MILLION.google;
  if (key.includes('openai') || key.includes('gpt')) return PER_MILLION.openai;
  return PER_MILLION.default;
}

export function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateTokenCostUsd(input: TokenCostInput) {
  const rate = ratesFor(input.provider, input.model);
  const tokensIn = Math.max(0, input.tokensIn ?? 0);
  const tokensOut = Math.max(0, input.tokensOut ?? 0);
  return roundUsd((tokensIn * rate.input + tokensOut * rate.output) / 1_000_000);
}

export function calculateEventCost(
  kind: GenerationEventKind,
  isUrlClone: boolean,
  tokens?: TokenCostInput | null,
) {
  const hasTokens = Boolean(tokens && ((tokens.tokensIn ?? 0) > 0 || (tokens.tokensOut ?? 0) > 0));
  if (hasTokens && tokens) {
    return roundUsd(estimateTokenCostUsd(tokens) + (isUrlClone ? FIRECRAWL_SCRAPE_ESTIMATE : 0));
  }
  if (kind === 'plan') return PLAN_GENERATION_ESTIMATE;
  if (kind === 'image') return IMAGE_GENERATION_ESTIMATE;
  const raw = AI_GENERATION_ESTIMATE + (isUrlClone ? FIRECRAWL_SCRAPE_ESTIMATE : 0);
  return Math.round(raw * 10000) / 10000;
}
