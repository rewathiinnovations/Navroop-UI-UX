import { resolveSandboxRunner } from '@/lib/audit/sandbox';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { installPackages } from '@/lib/sandbox/install-packages';
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
  sandboxId?: string | null;
  jobId?: string | null;
  attempt: number;
  previousSignature: string | null;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
}): Promise<BuildValidationOutcome> {
  const { stack, sandboxId, jobId, attempt, previousSignature, notify } = input;

  if (!(await getBuildAutoFixEnabled())) {
    return {
      result: { status: 'skipped', stack, errors: [], missingPackages: [], signature: null },
      decision: { action: 'none', reason: 'build-skipped' },
      retry: null,
    };
  }

  await notify('Checking the build…', 'info');

  const sandbox = resolveSandboxRunner(sandboxId);
  const result = await checkBuild({ stack, sandbox });

  if (result.status === 'skipped') {
    // Deliberately quiet: STATIC_HTML has no build step, and a missing sandbox
    // is not something the user can act on from the chat.
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
    await notify(
      `Build failed on missing packages: ${decision.packages.join(', ')}. Installing…`,
      'warning',
    );
    try {
      const installed = await installPackages({ packages: decision.packages });
      // Re-check rather than assume: the install can succeed while the build
      // still fails for a second, unrelated reason.
      const recheck = await checkBuild({ stack, sandbox });
      if (recheck.status === 'passed') {
        await notify('Installed the missing packages and the build now passes.', 'info');
        return { result: recheck, decision, retry: null };
      }
      if (!installed.ok) {
        await notify(`Could not install the missing packages: ${installed.error}`, 'warning');
      }
      // Still broken — fall through to the model with the *new* failure.
      const next = decideAutoFix({ result: recheck, attempt, previousSignature });
      if (next.action === 'install') {
        // A second round of missing packages. Installing again could ping-pong,
        // so stop here — but say so, or this exits silently on a broken build.
        await notify(
          `Still missing packages after installing: ${next.packages.join(', ')}. Stopping automatic fixes.`,
          'warning',
        );
        return { result: recheck, decision: next, retry: null };
      }
      if (next.action === 'stop') {
        await notify(`${describeBuildFailure(recheck)} ${next.detail}`, 'warning');
      }
      return {
        result: recheck,
        decision: next,
        retry:
          next.action === 'reprompt'
            ? { instruction: next.instruction, attempt: next.attempt, signature: recheck.signature }
            : null,
      };
    } catch (error) {
      await notify(
        `Could not install the missing packages: ${error instanceof Error ? error.message : String(error)}`,
        'warning',
      );
      return { result, decision, retry: null };
    }
  }

  if (decision.action === 'reprompt') {
    await notify(
      `${describeBuildFailure(result)} — attempting an automatic fix (${decision.attempt}/2).`,
      'warning',
    );
    return {
      result,
      decision,
      retry: { instruction: decision.instruction, attempt: decision.attempt, signature: result.signature },
    };
  }

  if (decision.action === 'stop') {
    // Say why it stopped. A silent stop is indistinguishable from a loop that
    // never ran, and leaves the user staring at a broken preview.
    await notify(`${describeBuildFailure(result)} ${decision.detail}`, 'warning');
  }

  return { result, decision, retry: null };
}
