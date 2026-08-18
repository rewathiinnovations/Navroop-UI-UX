import type { BuildCheckResult } from './build-check';
import { buildBuildFixInstruction } from './fix-prompt';

/**
 * Whether a failed build earns another generation, and which kind.
 *
 * Kept pure and separate from the apply route because the interesting part of an
 * auto-fix loop is not the retry — it is every condition under which it must
 * refuse to retry. A loop that re-prompts on a sandbox blip, or grinds through
 * the same error three times, costs the user credits and produces nothing.
 */

/**
 * Two model attempts. Beyond that a build error is nearly always something the
 * model cannot see (a bad dependency version, a sandbox difference), and further
 * attempts burn credits to re-emit the same file.
 */
export const MAX_AUTOFIX_ATTEMPTS = 2;

export type AutoFixDecision =
  | { action: 'none'; reason: 'build-passed' | 'build-skipped' }
  | { action: 'install'; reason: 'missing-packages'; packages: string[] }
  | { action: 'reprompt'; instruction: string; attempt: number }
  | { action: 'stop'; reason: 'attempts-exhausted' | 'no-progress' | 'not-actionable'; detail: string };

export function decideAutoFix(input: {
  result: BuildCheckResult;
  /** Model attempts already spent on this build. 0 on the first failure. */
  attempt: number;
  /** Signature of the previous failure, if this is already a retry. */
  previousSignature?: string | null;
}): AutoFixDecision {
  const { result, attempt, previousSignature } = input;

  if (result.status === 'passed') return { action: 'none', reason: 'build-passed' };
  // A skipped check is an absence of evidence, never evidence of a fault.
  if (result.status === 'skipped') return { action: 'none', reason: 'build-skipped' };

  // Identical failure after an edit means the model is not converging. Stopping
  // here is the difference between a loop and a bill.
  if (previousSignature && result.signature === previousSignature) {
    return {
      action: 'stop',
      reason: 'no-progress',
      detail: 'The build failed the same way after a fix attempt, so further attempts were stopped.',
    };
  }

  // Every error is a missing dependency: install is cheaper, faster, and more
  // reliable than asking a model to rewrite imports it already believes are right.
  const allMissing = result.errors.length > 0 && result.errors.every((error) => error.kind === 'missing-package');
  if (allMissing && result.missingPackages.length > 0) {
    return { action: 'install', reason: 'missing-packages', packages: result.missingPackages };
  }

  if (attempt >= MAX_AUTOFIX_ATTEMPTS) {
    return {
      action: 'stop',
      reason: 'attempts-exhausted',
      detail: `The build still fails after ${MAX_AUTOFIX_ATTEMPTS} fix attempts.`,
    };
  }

  if (result.errors.length === 0) {
    return {
      action: 'stop',
      reason: 'not-actionable',
      detail: 'The build failed but produced no error a fix could target.',
    };
  }

  return { action: 'reprompt', instruction: buildBuildFixInstruction(result), attempt: attempt + 1 };
}
