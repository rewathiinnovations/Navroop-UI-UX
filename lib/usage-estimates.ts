/**
 * ASSUMPTION: these are rough fixed-constant estimates, NOT live
 * Firecrawl / E2B / AI billing. Not a source of truth for invoicing.
 */
export const FIRECRAWL_SCRAPE_ESTIMATE = 0.001;
export const E2B_SANDBOX_ESTIMATE = 0.02;
export const AI_GENERATION_ESTIMATE = 0.05;
/** Approximation only — plan-only AI call, no E2B/Firecrawl. Not live billing. */
export const PLAN_GENERATION_ESTIMATE = 0.02;
/** Approximation only — one image generation call. Not live billing. */
export const IMAGE_GENERATION_ESTIMATE = 0.04;

export type GenerationEventKind = 'initial' | 'followup' | 'plan' | 'image';

export function calculateEventCost(kind: GenerationEventKind, isUrlClone: boolean) {
  if (kind === 'plan') {
    return PLAN_GENERATION_ESTIMATE;
  }
  if (kind === 'image') {
    return IMAGE_GENERATION_ESTIMATE;
  }
  const raw =
    AI_GENERATION_ESTIMATE +
    E2B_SANDBOX_ESTIMATE +
    (isUrlClone ? FIRECRAWL_SCRAPE_ESTIMATE : 0);
  return Math.round(raw * 10000) / 10000;
}
