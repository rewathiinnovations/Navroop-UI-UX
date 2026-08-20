import { describe, expect, it } from 'vitest';
import {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
} from '@/lib/usage-estimates';
import { calculateEventCost } from '@/lib/consumption/cost';

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
