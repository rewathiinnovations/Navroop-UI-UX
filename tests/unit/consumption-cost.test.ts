import { describe, expect, it } from 'vitest';
import {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
} from '@/lib/usage-estimates';
import {
  DEEPSEEK_PER_MILLION,
  calculateEventCost,
  estimateTokenCost,
  resolveTokenRate,
} from '@/lib/consumption/cost';

/**
 * The sandbox VM subsystem is gone (migration 20260819010000_drop_sandbox_columns),
 * so a generation's flat estimate is the AI call alone — /admin/usage must not
 * bill $0.02 per build for a resource that no longer exists (F-750). The old
 * pinned totals (0.07 / 0.071) encoded that bug.
 */
describe('calculateEventCost', () => {
  it('no longer adds a sandbox estimate to flat build costs', () => {
    expect(calculateEventCost('initial', false)).toBe(AI_GENERATION_ESTIMATE);
    expect(calculateEventCost('followup', false)).toBe(AI_GENERATION_ESTIMATE);
  });

  it('adds only the Firecrawl scrape for URL clones', () => {
    const expected =
      Math.round((AI_GENERATION_ESTIMATE + FIRECRAWL_SCRAPE_ESTIMATE) * 10000) / 10000;
    expect(calculateEventCost('initial', true)).toBe(expected);
    expect(calculateEventCost('followup', true)).toBe(expected);
  });

  it('keeps plan and image flat estimates unchanged', () => {
    expect(calculateEventCost('plan', false)).toBe(PLAN_GENERATION_ESTIMATE);
    expect(calculateEventCost('plan', true)).toBe(PLAN_GENERATION_ESTIMATE);
    expect(calculateEventCost('image', false)).toBe(IMAGE_GENERATION_ESTIMATE);
    expect(calculateEventCost('image', true)).toBe(IMAGE_GENERATION_ESTIMATE);
  });

  it('prefers token-based cost over the flat estimate when tokens are present', () => {
    const tokenBased = calculateEventCost('initial', false, {
      tokensIn: 2000,
      tokensOut: 8000,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(tokenBased).toBeGreaterThan(0);
    expect(tokenBased).not.toBe(AI_GENERATION_ESTIMATE);
  });
});

/**
 * DeepSeek is the only provider, and until this was fixed the rate table did not
 * mention it: `ratesFor('deepseek', 'deepseek-v4-flash')` matched none of the
 * groq/anthropic/google/openai branches and fell through to a `default` entry
 * holding an OpenAI mini-model rate of 0.15 / 0.60 per million (F-029). That
 * number became `Job.estimatedCostUsd` and drove the workspace spend ceiling.
 */
describe('DeepSeek token rates', () => {
  const MILLION = 1_000_000;

  it('prices a DeepSeek call from the DeepSeek table, not the old OpenAI default', () => {
    const flash = estimateTokenCost({
      tokensIn: MILLION,
      tokensOut: 0,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(flash.usd).toBe(DEEPSEEK_PER_MILLION.flash.input);
    // The fabricated rate this finding is about.
    expect(flash.usd).not.toBe(0.15);

    const output = estimateTokenCost({
      tokensIn: 0,
      tokensOut: MILLION,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(output.usd).toBe(DEEPSEEK_PER_MILLION.flash.output);
    expect(output.usd).not.toBe(0.6);
  });

  it('charges the reasoning tier more than the fast tier', () => {
    const of = (model: string) =>
      estimateTokenCost({ tokensIn: MILLION, tokensOut: MILLION, provider: 'deepseek', model }).usd;
    expect(of('deepseek-v4-pro')).toBeGreaterThan(of('deepseek-v4-flash'));
  });

  it('reports a built-in rate as an unconfirmed default so an operator can see it is a guess', () => {
    expect(resolveTokenRate('deepseek', 'deepseek-v4-flash').source).toBe('unconfirmed-default');
    expect(resolveTokenRate('deepseek', 'deepseek-v4-pro').source).toBe('unconfirmed-default');
  });

  it('uses an operator-confirmed rate in place of the built-in default', () => {
    const rate = { input: 1, output: 2 };
    const resolved = resolveTokenRate('deepseek', 'deepseek-v4-flash', rate);
    expect(resolved.source).toBe('operator');
    expect(resolved.rate).toEqual(rate);

    const priced = estimateTokenCost({
      tokensIn: MILLION,
      tokensOut: MILLION,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      rate,
    });
    expect(priced.usd).toBe(3);
    expect(priced.source).toBe('operator');
  });

  it('flags a provider the table does not price instead of pricing it silently', () => {
    const resolved = resolveTokenRate('openai', 'gpt-4o-mini');
    expect(resolved.source).toBe('unpriced-provider');
    // Still priced — a job that spent tokens must not report zero — but the
    // caller is told the number is not a rate for that vendor.
    expect(resolved.rate).toEqual(DEEPSEEK_PER_MILLION.flash);
  });
});
