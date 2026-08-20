import {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
  type GenerationEventKind,
} from '@/lib/usage-estimates';

export type Rate = { input: number; output: number };

/** Where the rate used for an estimate came from. */
export type RateSource =
  /** Both knobs on /admin/config carry a number the operator entered. */
  | 'operator'
  /** A built-in DeepSeek list price. Nobody in this repository has checked it. */
  | 'unconfirmed-default'
  /** The provider is not in the table at all — priced, but not at its own rate. */
  | 'unpriced-provider';

export type TokenCostInput = {
  tokensIn?: number | null;
  tokensOut?: number | null;
  provider?: string | null;
  model?: string | null;
  /**
   * Operator-confirmed per-million rate, from `loadOperatorTokenRate` in
   * ./rates. Supplied by the async callers (`recordJobUsage`,
   * `logGenerationEvent`) so both write the same number for one generation.
   */
  rate?: Rate | null;
};

/**
 * DeepSeek per-million token rates, by tier.
 *
 * This table used to list groq, openai, anthropic, google and a `default`, and
 * not DeepSeek — which is the only provider the product has
 * (lib/ai/providers.ts). `ratesFor('deepseek', 'deepseek-v4-flash')` matched no
 * branch and fell through to `default` = { 0.15, 0.6 }, an OpenAI mini-model
 * rate. That number became `Job.estimatedCostUsd` and was accrued into
 * `Workspace.spendUsd`, which drives the documented auto-pause at 100 % of
 * `monthlySpendLimitUsd`. So the spend ceiling ran on a price belonging to a
 * vendor the installation does not call (F-029).
 *
 * PROVENANCE — read before trusting these numbers. They are DeepSeek's
 * published list prices as transcribed by hand: the `flash` tier from the chat
 * model (cache-miss input) and the `pro` tier from the reasoning model. This
 * code cannot reach the network, no invoice is stored in the repository, and
 * the installation's model names (`deepseek-v4-flash` / `deepseek-v4-pro`,
 * lib/settings/registry.ts) are mapped onto those two tiers by assumption.
 * They are therefore a CONFIGURED DEFAULT the operator must confirm, and
 * `resolveTokenRate` reports them as `unconfirmed-default` until they do. The
 * two knobs that replace them are on /admin/config → AI providers
 * (`ai.cost.inputPerMillionUsd`, `ai.cost.outputPerMillionUsd`); the help text
 * there says the same thing in the operator's own words. Correct these numbers
 * whenever a real invoice contradicts them.
 */
export const DEEPSEEK_PER_MILLION = {
  flash: { input: 0.27, output: 1.1 },
  pro: { input: 0.55, output: 2.19 },
} as const satisfies Record<string, Rate>;

/**
 * Which DeepSeek tier a call belongs to, or null when the call was not DeepSeek.
 *
 * Both fields are read, not `provider || model`: the provider is the literal
 * `deepseek` for every call, so the old expression never saw the model and
 * could not have told the tiers apart even with a table to look them up in.
 * A DeepSeek call with no model recorded is priced as the cheaper tier.
 */
function deepseekTier(provider?: string | null, model?: string | null) {
  const key = `${provider ?? ''} ${model ?? ''}`.toLowerCase();
  if (!key.includes('deepseek')) return null;
  return key.includes('-pro') || key.includes('reason') ? 'pro' : 'flash';
}

/**
 * The rate to price a call at, and how much that rate is worth believing.
 *
 * Nothing here silently substitutes another vendor's price. An unpriced
 * provider is still priced — a job that spent tokens reporting $0 is how the
 * spend ceiling stopped being a control — but it is returned as
 * `unpriced-provider` so the caller can say so out loud (see ./rates).
 */
export function resolveTokenRate(
  provider?: string | null,
  model?: string | null,
  operatorRate?: Rate | null,
): { rate: Rate; source: RateSource } {
  if (operatorRate) return { rate: operatorRate, source: 'operator' };
  const tier = deepseekTier(provider, model);
  if (!tier) return { rate: DEEPSEEK_PER_MILLION.flash, source: 'unpriced-provider' };
  return { rate: DEEPSEEK_PER_MILLION[tier], source: 'unconfirmed-default' };
}

export function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Priced cost plus the provenance of the rate it was priced at. */
export function estimateTokenCost(input: TokenCostInput) {
  const { rate, source } = resolveTokenRate(input.provider, input.model, input.rate);
  const tokensIn = Math.max(0, input.tokensIn ?? 0);
  const tokensOut = Math.max(0, input.tokensOut ?? 0);
  return {
    usd: roundUsd((tokensIn * rate.input + tokensOut * rate.output) / 1_000_000),
    rate,
    source,
  };
}

export function estimateTokenCostUsd(input: TokenCostInput) {
  return estimateTokenCost(input).usd;
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
