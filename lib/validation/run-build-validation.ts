import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { PREVIEW_DEPS } from '@/lib/preview/deps';
import type { StackId } from '@/lib/stacks';
import { checkBuild, type BuildCheckResult } from './build-check';
import { decideAutoFix, type AutoFixDecision } from './autofix-policy';
import { describeBuildFailure } from './fix-prompt';
import { getBuildAutoFixEnabled } from './settings';

/**
 * Post-apply build validation and the decision about what to do with a failure.
 * Lives here rather than in the route so the route stays a thin wrapper
 * (AGENTS.md) and so the policy is reachable from tests without an HTTP request.
 */

export type BuildRetry = {
  instruction: string;
  attempt: number;
  /** Echoed back on the retry so the next run can detect a repeated failure. */
  signature: string | null;
};

export type BuildValidationOutcome = {
  result: BuildCheckResult;
  decision: AutoFixDecision;
  /** Non-null only when the client should run another generation. */
  retry: BuildRetry | null;
};

type NotifyLevel = 'info' | 'warning';

export async function runBuildValidation(input: {
  stack: StackId;
  /** The generated files, keyed by repo-relative path. */
  files: Record<string, string>;
  jobId?: string | null;
  attempt: number;
  previousSignature: string | null;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
}): Promise<BuildValidationOutcome> {
  const { stack, files, jobId, attempt, previousSignature, notify } = input;

  if (!(await getBuildAutoFixEnabled())) {
    return {
      result: { status: 'skipped', stack, errors: [], missingPackages: [], signature: null },
      decision: { action: 'none', reason: 'build-skipped' },
      retry: null,
    };
  }

  await notify('Checking the build…', 'info');

  const result = await checkBuild({ stack, files });

  if (result.status === 'skipped') {
    // Deliberately quiet: STATIC_HTML has nothing to compile, and an empty file
    // set is not something the user can act on from the chat.
    return { result, decision: { action: 'none', reason: 'build-skipped' }, retry: null };
  }

  if (result.status === 'passed') {
    await notify('Build passed.', 'info');
    return { result, decision: { action: 'none', reason: 'build-passed' }, retry: null };
  }

  const decision = decideAutoFix({ result, attempt, previousSignature });

  // A failing build is a real job failure even when the loop then repairs it —
  // /admin/jobs should show that the first build did not compile.
  await recordJobStepFailure(jobId, {
    key: 'validate-build',
    label: 'Validate build',
    error: describeBuildFailure(result),
  });

  if (decision.action === 'install') {
    // Nothing to install into: preview dependencies are resolved from esm.sh at
    // runtime, so an unknown import is code the model has to change rather than
    // a package we can add.
    const supported = Object.keys(PREVIEW_DEPS).join(', ');
    await notify(
      `The build used packages that are not available: ${decision.packages.join(', ')}. Asking for a version that uses only the supported ones.`,
      'warning',
    );
    return {
      result,
      decision,
      retry: {
        instruction: `The build failed because these packages are not available in the preview: ${decision.packages.join(', ')}. Rewrite the affected files using only these packages: ${supported}. Do not add any other dependency.`,
        attempt: attempt + 1,
        signature: result.signature,
      },
    };
  }

  if (decision.action === 'reprompt') {
    await notify(
      `${describeBuildFailure(result)} — attempting an automatic fix (${decision.attempt}/2).`,
      'warning',
    );
    return {
      result,
      decision,
      retry: {
        instruction: decision.instruction,
        attempt: decision.attempt,
        signature: result.signature,
      },
    };
  }

  if (decision.action === 'stop') {
    // Say why it stopped. A silent stop is indistinguishable from a loop that
    // never ran, and leaves the user staring at a broken preview.
    await notify(`${describeBuildFailure(result)} ${decision.detail}`, 'warning');
  }

  return { result, decision, retry: null };
}
