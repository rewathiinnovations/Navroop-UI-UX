/**
 * ASSUMPTION: these are rough fixed-constant estimates, NOT live
 * Firecrawl / AI billing. Not a source of truth for invoicing.
 *
 * The live cost function is `calculateEventCost` in lib/consumption/cost.ts —
 * it reads these constants and prefers token-based cost when tokens exist.
 */
export const FIRECRAWL_SCRAPE_ESTIMATE = 0.001;
export const AI_GENERATION_ESTIMATE = 0.05;
/** Approximation only — plan-only AI call, no Firecrawl. Not live billing. */
export const PLAN_GENERATION_ESTIMATE = 0.02;
/** Approximation only — one image generation call. Not live billing. */
export const IMAGE_GENERATION_ESTIMATE = 0.04;

export type GenerationEventKind = 'initial' | 'followup' | 'plan' | 'image';
