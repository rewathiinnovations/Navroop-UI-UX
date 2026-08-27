import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { PREVIEW_DEPS } from '@/lib/preview/deps';
import type { StackId } from '@/lib/stacks';
import { withStarterFiles } from '@/lib/stacks/starter';
import { checkBuild, type BuildCheckResult } from './build-check';
import { MAX_AUTOFIX_ATTEMPTS, decideAutoFix, type AutoFixDecision } from './autofix-policy';
import { describeBuildFailure } from './fix-prompt';
import { checkGeneratedImports, type ImportCheckOutcome } from './import-check';
import { getBuildAutoFixEnabled } from './settings';

/**
 * Validates generated code and decides what to do with a failure. Lives here
 * rather than in the route so the route stays a thin wrapper (AGENTS.md) and so
 * the policy is reachable from tests without an HTTP request.
 *
 * Two checks, cheapest first:
 *
 * 1. the static import/export scan — free, deterministic, and the class that
 *    reached a user (`No matching export in "vfs:lib/data.ts" for import "site"`),
 * 2. the esbuild bundle — the same compile the preview runs, which also catches
 *    syntax and JSX errors.
 *
 * Neither can skip on infrastructure grounds, which is what the deleted sandbox
 * version did on every single run. The only skips left are honest ones: a stack
 * with no module graph, and an empty file set.
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
  /**
   * Everything the bundle can see, keyed by repo-relative path: for an edit that
   * means the project's stored files merged with the newly generated ones. A
   * partial map makes a correct one-file edit look like a broken project.
   */
  files: Record<string, string>;
  /**
   * The paths this run generated. Problems in files the model did not touch are
   * pre-existing and must not fail this build.
   */
  changedPaths?: string[];
  /**
   * Decides the starter kit's token block. Without it the *static* scan reports
   * `@/lib/utils` as an unresolved import and spends a repair generation
   * rewriting correct code — the false-positive class docs/build-autofix.md
   * names as the failure mode that matters.
   */
  designDirection?: string | null;
  jobId?: string | null;
  attempt: number;
  previousSignature: string | null;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
}): Promise<BuildValidationOutcome> {
  const { stack, changedPaths, designDirection, jobId, attempt, previousSignature, notify } = input;
  // The starter kit is part of the project as far as both checks are concerned:
  // it is what the preview, the published site and the exported repo compile
  // against, so a scan that cannot see it is scanning a different project.
  const files = withStarterFiles(stack, input.files, designDirection);

  // Read once: the setting decides whether a failure earns a repair generation,
  // not whether the code gets checked. Checking is free and its absence is what
  // let a broken import reach the browser.
  const enabled = await getBuildAutoFixEnabled();

  let imports: ImportCheckOutcome;
  try {
    imports = checkGeneratedImports({ stack, files, scope: changedPaths });
  } catch (error) {
    // A crash in the scanner must not lose a generation the user already paid
    // for, and must not pass for a clean verdict either.
    return {
      result: await reportUnchecked({
        stack,
        jobId,
        notify,
        detail: error instanceof Error ? error.message : String(error),
      }),
      decision: { action: 'none', reason: 'build-skipped' },
      retry: null,
    };
  }

  for (const warning of imports.warnings) {
    // A cycle is legal ESM: say it, never rewrite for it.
    await notify(warning, 'warning');
  }

  if (imports.result.status === 'failed') {
    // The static messages name the file and the symbol in plain English, which is
    // better repair copy than esbuild's, so the bundle check is not run: it would
    // fail on the same import and cost a compile to say less.
    return settleFailure({
      result: imports.result,
      summary: imports.summary,
      jobId,
      attempt,
      previousSignature,
      enabled,
      notify,
    });
  }

  const result = await runBundleCheck({ stack, files, designDirection, jobId, notify });

  if (result.status === 'skipped') {
    // STATIC_HTML and an empty file set are quiet on purpose — there is nothing
    // to compile and nothing the user could act on. `checker-unavailable` is not
    // quiet: it is already reported by runBundleCheck, because a check that did
    // not happen must never read as a check that passed.
    return { result, decision: { action: 'none', reason: 'build-skipped' }, retry: null };
  }

  if (result.status === 'passed') {
    await notify('Checked the generated code: imports resolve and the build compiles.', 'info');
    return { result, decision: { action: 'none', reason: 'build-passed' }, retry: null };
  }

  return settleFailure({
    result,
    summary: describeBuildFailure(result),
    jobId,
    attempt,
    previousSignature,
    enabled,
    notify,
  });
}

/**
 * The bundle compile, with the two ways it can fail to *be* a check made loud.
 *
 * A generation that produced files is already paid for and already saved, so a
 * checker that throws must not take it down — and must not pass in silence
 * either. Both outcomes here say so in chat and on the job, and neither returns
 * a fault the model would be asked to fix: the code was never examined.
 */
async function runBundleCheck(input: {
  stack: StackId;
  files: Record<string, string>;
  designDirection?: string | null;
  jobId?: string | null;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
}): Promise<BuildCheckResult> {
  const { stack, files, designDirection, jobId, notify } = input;
  try {
    const result = await checkBuild({ stack, files, designDirection });
    if (result.skipReason !== 'checker-unavailable') return result;
    return reportUnchecked({ stack, jobId, notify, detail: 'the bundler is unavailable' });
  } catch (error) {
    return reportUnchecked({
      stack,
      jobId,
      notify,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Says, in chat and on the job, that the code was not examined — and returns a
 * `skipped` result, so the policy cannot mistake a check that did not run for a
 * fault the model should be asked to fix.
 */
async function reportUnchecked(input: {
  stack: StackId;
  jobId?: string | null;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
  detail: string;
}): Promise<BuildCheckResult> {
  const { stack, jobId, notify, detail } = input;
  await notify(
    `Could not check the generated site (${detail}). The files were saved as generated — open the preview to confirm it renders.`,
    'warning',
  );
  await recordJobStepFailure(jobId, {
    key: 'validate-build',
    label: 'Validate the generated code',
    error: `The check did not run: ${detail}`,
  });
  return {
    status: 'skipped',
    stack,
    errors: [],
    missingPackages: [],
    signature: null,
    skipReason: 'checker-unavailable',
  };
}

/**
 * Everything a failed check owes the user and the job record: a chat message in
 * plain English, a `validate-build` job step, and a retry payload only when the
 * policy allows one. Shared by both checks so neither can grow a quieter path.
 *
 * A returned `retry` is not advice: the workspace turns it straight into another
 * POST to /api/generate-ai-code-stream, which charges a credit unconditionally.
 * So the ceiling below is applied here, over *every* branch that can produce one,
 * rather than left to `decideAutoFix` — which tests `attempt >= MAX_AUTOFIX_ATTEMPTS`
 * only after its missing-package branch has already returned. A reply whose errors
 * are all unresolvable packages therefore earned an `install` retry at any attempt
 * number, and the sole thing that ended the client's recursion was the model
 * happening to emit a byte-identical failure signature twice. One user message
 * could bill generations for as long as the model kept naming a different missing
 * package. A bound has to be arithmetic on a counter the server owns; the model
 * changing its mind is not a bound.
 */
async function settleFailure(input: {
  result: BuildCheckResult;
  summary: string;
  jobId?: string | null;
  attempt: number;
  previousSignature: string | null;
  enabled: boolean;
  notify: (message: string, level: NotifyLevel) => void | Promise<void>;
}): Promise<BuildValidationOutcome> {
  const { result, summary, jobId, attempt, previousSignature, enabled, notify } = input;
  const decision = decideAutoFix({ result, attempt, previousSignature, enabled });

  // A failing check is a real job failure even when the loop then repairs it —
  // /admin/jobs should show that the first build did not work.
  await recordJobStepFailure(jobId, {
    key: 'validate-build',
    label: 'Validate the generated code',
    error: summary,
  });

  if (
    (decision.action === 'install' || decision.action === 'reprompt') &&
    attempt >= MAX_AUTOFIX_ATTEMPTS
  ) {
    const exhausted: AutoFixDecision = {
      action: 'stop',
      reason: 'attempts-exhausted',
      detail: `The build still fails after ${MAX_AUTOFIX_ATTEMPTS} automatic fix attempts, so no further generation was spent on it.`,
    };
    await notify(`${summary} ${exhausted.detail}`, 'warning');
    return { result, decision: exhausted, retry: null };
  }

  if (decision.action === 'install') {
    // Nothing to install into: preview dependencies are resolved from esm.sh at
    // runtime, so an unknown import is code the model has to change rather than
    // a package we can add.
    const supported = Object.keys(PREVIEW_DEPS).join(', ');
    // Says what it costs. This branch spends a generation exactly like the
    // re-prompt below, and describing it as merely "asking for a version" is how
    // a second and third billed run went unattributed in the transcript.
    await notify(
      `The build used packages that are not available: ${decision.packages.join(', ')}. Asking for a version that uses only the supported ones — automatic fix ${attempt + 1} of ${MAX_AUTOFIX_ATTEMPTS}, which runs as its own generation and is charged like any other message.`,
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
    // The `/2` here was a literal while the ceiling lived in a constant, so the
    // two could disagree without anything failing. It also never said that the
    // attempt costs money.
    await notify(
      `${summary} — automatic fix ${decision.attempt} of ${MAX_AUTOFIX_ATTEMPTS}, which runs as its own generation and is charged like any other message.`,
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
    // Say why it stopped. A silent stop is indistinguishable from a check that
    // never ran, and leaves the user staring at a broken preview.
    await notify(`${summary} ${decision.detail}`, 'warning');
  }

  return { result, decision, retry: null };
}
