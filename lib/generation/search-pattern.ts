/**
 * Gate for regular expressions a model wrote.
 *
 * `SearchPlan.regexPatterns` comes straight out of a model reply. JavaScript
 * regex execution is synchronous and cannot be interrupted, so one
 * catastrophically backtracking pattern — `(a+)+$`, `(\w+\s?)*$`, the shapes a
 * model emits naturally when asked for a "flexible" matcher — blocks the Node
 * event loop for as long as it runs. That stalls *every* request the process is
 * serving, not just the generation whose plan asked for it (F-752).
 *
 * The executor that used to compile and run these per line of every file
 * (`lib/file-search-executor.ts`) was deleted, so nothing runs them today. The
 * plan is still built and still returned by `POST /api/analyze-edit-intent`, so
 * the bound belongs where the patterns *enter* the system: refusing a pattern is
 * always cheaper than stalling the process, and the next consumer gets one gate
 * to call rather than having to rediscover why this is dangerous.
 */

/** Long enough for any real `className=["'].*header.*["']` search. */
export const MAX_SEARCH_PATTERN_LENGTH = 200;
/** A plan needs a handful of patterns; hundreds is a denial-of-service shape. */
export const MAX_SEARCH_PATTERNS = 8;
/** `a{5000}` is linear per attempt but multiplies with everything around it. */
const MAX_REPEAT_COUNT = 100;

const QUANTIFIERS: Record<string, true> = { '*': true, '+': true, '?': true, '{': true };

/**
 * Why the pattern's *shape* is refused, or null.
 *
 * One left-to-right pass. Escapes and character classes are tracked so `\(` and
 * `[(+]` are read as literals, and a group stack records whether each group body
 * held a quantifier — a quantified group whose body is itself quantified is the
 * nested-quantifier shape that backtracks exponentially.
 */
function riskyShape(pattern: string): string | null {
  /** Whether the body at each open depth has seen a quantifier. Index 0 is top level. */
  const quantifiedBody: boolean[] = [false];
  let inClass = false;
  let previousWasQuantifier = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '\\') {
      // The escape and its target are one literal; neither can be a quantifier.
      i += 1;
      previousWasQuantifier = false;
      continue;
    }

    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      previousWasQuantifier = false;
      continue;
    }

    if (char === '(') {
      quantifiedBody.push(false);
      previousWasQuantifier = false;
      continue;
    }

    if (char === ')') {
      const bodyWasQuantified = quantifiedBody.length > 1 ? quantifiedBody.pop()! : false;
      const next = pattern[i + 1];
      // `(a+)?` cannot repeat, so it is not the exponential shape; `*`, `+` and
      // `{…}` all can.
      const repeats = next === '*' || next === '+' || next === '{';
      if (bodyWasQuantified && repeats) {
        return 'nests a quantifier inside a repeated group, which can backtrack exponentially';
      }
      // The group is now a single unit. A quantifier that follows applies to the
      // whole group (`(a+)?` is one quantifier on the group, not a stack), so the
      // inner quantifier must not leave `previousWasQuantifier` set.
      previousWasQuantifier = false;
      continue;
    }

    if (!QUANTIFIERS[char]) {
      previousWasQuantifier = false;
      continue;
    }

    if (char === '{') {
      const close = pattern.indexOf('}', i);
      const bounds = close === -1 ? null : pattern.slice(i + 1, close);
      if (bounds === null || !/^\d+(,\d*)?$/.test(bounds)) {
        // A literal brace, not a repetition — `\{` is the escaped form but bare
        // `{` is legal too, and it quantifies nothing.
        previousWasQuantifier = false;
        continue;
      }
      const counts = bounds.split(',').filter(Boolean).map(Number);
      if (counts.some((count) => count > MAX_REPEAT_COUNT)) {
        return `repeats more than ${MAX_REPEAT_COUNT} times`;
      }
      i = close;
    }

    if (previousWasQuantifier) {
      return 'stacks two quantifiers on one term';
    }
    quantifiedBody[quantifiedBody.length - 1] = true;
    previousWasQuantifier = true;
  }

  return null;
}

/**
 * Why this pattern must not be handed on, or null when it is safe to keep.
 *
 * The reason is human-readable on purpose: whatever drops the pattern has to be
 * able to say what it dropped and why, rather than shrinking the plan in silence.
 */
export function unsafeSearchPatternReason(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return 'is empty';
  }
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    return `is longer than ${MAX_SEARCH_PATTERN_LENGTH} characters`;
  }
  const shape = riskyShape(pattern);
  if (shape) return shape;
  try {
    new RegExp(pattern, 'i');
  } catch {
    return 'is not a valid regular expression';
  }
  return null;
}

export type SearchPatternFilter = {
  /** Patterns that passed every bound, capped at `MAX_SEARCH_PATTERNS`. */
  safe: string[];
  /** One entry per refusal, so the caller can report rather than swallow it. */
  refused: { pattern: string; reason: string }[];
};

/**
 * Splits model-supplied patterns into the ones a consumer may compile and the
 * ones it may not. Over the cap, the extras are refused by name too — a bounded
 * pattern count is part of the bound.
 */
export function filterSearchPatterns(
  patterns: readonly unknown[] | undefined,
): SearchPatternFilter {
  const safe: string[] = [];
  const refused: { pattern: string; reason: string }[] = [];
  for (const candidate of patterns ?? []) {
    const asText = typeof candidate === 'string' ? candidate : String(candidate);
    const reason = unsafeSearchPatternReason(candidate);
    if (reason) {
      refused.push({ pattern: asText, reason });
      continue;
    }
    if (safe.length >= MAX_SEARCH_PATTERNS) {
      refused.push({ pattern: asText, reason: `exceeds the ${MAX_SEARCH_PATTERNS}-pattern limit` });
      continue;
    }
    safe.push(asText);
  }
  return { safe, refused };
}
