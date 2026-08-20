/**
 * There is no i18n catalog, so user-facing copy must stay English.
 *
 * Two rules, both enforced by `tests/unit/i18n-copy.test.ts` over `app/`,
 * `components/` and `lib/`:
 *
 * - **Devanagari** — a Hindi string in shipped copy means a prompt or a paste
 *   leaked the author's own language into the product, and there is no catalog
 *   to render it from.
 * - **`klarco`** — a brand name that is not this product's. It has never
 *   appeared anywhere in this repo except as the thing being banned, so it is a
 *   placeholder or prior name that leaked into copy once and must not come back
 *   under Navroop's chrome (`.cursor/rules/navroop-product.mdc`). The ban is
 *   asserted in four places on purpose: this scan, `tests/templates.test.ts`
 *   over the built-in template rows, `e2e/journeys-critical.spec.ts` over the
 *   rendered sign-in page, and `docs/release.md`. If the word ever becomes
 *   legitimate, all four move together.
 *
 * There is deliberately no throwing wrapper. `assertEnglishUserCopy` existed
 * with zero callers (F-768); a copy rule is a build-time guard, not something a
 * request path should be able to fail on.
 */

const DEVANAGARI = /[\u0900-\u097F]/;
const BANNED_BRAND = /\bklarco\b/i;

export function findNonEnglishUserCopy(text: string) {
  const hits: string[] = [];
  if (DEVANAGARI.test(text)) hits.push('hindi');
  if (BANNED_BRAND.test(text)) hits.push('klarco');
  return hits;
}
