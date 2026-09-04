import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { PREVIEW_DEPS } from '@/lib/preview/deps';
import type { StackId } from '@/lib/stacks';
import { withStarterFiles } from '@/lib/stacks/starter';
import {
  buildErrorSignature,
  checkBuild,
  type BuildCheckResult,
  type BuildError,
} from './build-check';
import { MAX_AUTOFIX_ATTEMPTS, decideAutoFix, type AutoFixDecision } from './autofix-policy';
import { describeBuildFailure } from './fix-prompt';
import { checkGeneratedImports, type ImportCheckOutcome } from './import-check';
import { checkGeneratedQuality, type PlannedPage, type QualityFinding } from './quality-check';
import { getBuildAutoFixEnabled } from './settings';
import { typecheckGenerated } from './typecheck';

/**
 * Stable across runs that found the same defects, so a repair that changed
 * nothing is recognised as no progress instead of billing a third attempt.
 */
function qualitySignature(findings: readonly QualityFinding[]): string {
  return findings
    .map((finding) => `${finding.kind}:${finding.file}`)
    .sort()
    .join('|');
}

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

/**
 * The verdict stored beside the files, from the verdict used to decide a repair pass.
 *
 * Three states because there are three, and collapsing them is the bug this whole area keeps
 * relearning: `skipped` is not `passed`. A stack with no module graph and an empty file set
 * both end here, and neither is evidence that anything works — so they record `null`, and the
 * read path that decides whether to hold a broken site back from the preview declines to act
 * on them rather than treating "nobody looked" as a clean bill of health.
 *
 * Quality findings deliberately do not count. A nav link to a page nobody wrote is a real
 * finding and not a reason to call the site broken; this answers "does it build", which is
 * the only question the hold-back is entitled to act on.
 */
export function siteValidatedFromBuild(outcome: BuildValidationOutcome | null): boolean | null {
  if (!outcome) return null;
  if (outcome.result.status === 'passed') return true;
  if (outcome.result.status === 'failed') return false;
  return null;
}

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
   * Routes the approved plan promised, passed only on a first build.
   *
   * The caller decides that: this function has no idea whether a run is an edit,
   * and `checkGeneratedQuality` must not guess — a follow-up edit that touches
   * one page would otherwise be failed for the pages it correctly left alone.
   */
  plannedRoutes?: readonly string[];
  /** The approved plan's pages, for the section half of the same contract. */
  plannedPages?: readonly PlannedPage[];
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
    // Bundling is not type-checking. esbuild strips TypeScript rather than reading it, so a
    // section given a prop it does not have, or a variant a component never defined, gets
    // this far untouched — and `BuildErrorKind` has carried a `'type'` arm since it was
    // written that nothing could produce. Next.js *does* type-check on `next build`, so the
    // discovery point without this stage is inside the client's own repository after
    // publish, which is the one place in the product that cannot repair anything.
    //
    // After the bundle rather than before it: a syntax error should fail on the cheaper
    // check, and a program built over unparseable files reports noise about the parse.
    const types = typecheckGenerated({ stack, files: input.files, changedPaths, designDirection });
    if (types.status === 'failed') {
      const typed: BuildCheckResult = {
        ...result,
        status: 'failed',
        errors: types.errors,
        signature: buildErrorSignature(types.errors),
      };
      return settleFailure({
        result: typed,
        summary: typeCheckSummary(types.errors),
        jobId,
        attempt,
        previousSignature,
        enabled,
        notify,
      });
    }

    // Compiling is not the same as working. The checks below are the ones a
    // bundler has no opinion about: a nav link to a route nobody wrote, a
    // transparent button variant given a light foreground and no background.
    // Both shipped to a user on a build this same line called clean.
    const quality = checkGeneratedQuality({
      stack,
      files,
      changedPaths,
      plannedRoutes: input.plannedRoutes,
      plannedPages: input.plannedPages,
    });
    for (const finding of quality.advisory.slice(0, 3)) {
      await notify(finding.message, 'warning');
    }

    if (quality.blocking.length === 0) {
      await notify('Checked the generated code: imports resolve and the build compiles.', 'info');
      return { result, decision: { action: 'none', reason: 'build-passed' }, retry: null };
    }

    const signature = qualitySignature(quality.blocking);
    const repeated = previousSignature !== null && previousSignature === signature;
    if (!enabled || repeated || attempt >= MAX_AUTOFIX_ATTEMPTS) {
      // Say what is wrong even when nothing will be spent fixing it: a silent
      // pass over a nav that 404s is how the defect reached a person.
      await notify(
        `${quality.summary} ${
          repeated
            ? 'The same issues came back after a repair, so no further generation was spent on them.'
            : 'They were left as generated.'
        }`,
        'warning',
      );
      await recordJobStepFailure(jobId, {
        key: 'validate-quality',
        label: 'Check the generated site for visible defects',
        error: quality.summary,
      });
      return {
        result,
        decision: {
          action: 'stop',
          reason: 'quality-left-as-is',
          detail: quality.summary,
        },
        retry: null,
      };
    }

    await recordJobStepFailure(jobId, {
      key: 'validate-quality',
      label: 'Check the generated site for visible defects',
      error: quality.summary,
    });
    await notify(
      `${quality.summary} Fixing them automatically — attempt ${attempt + 1} of ${MAX_AUTOFIX_ATTEMPTS}, which runs as its own generation.`,
      'warning',
    );
    return {
      result,
      decision: { action: 'reprompt', instruction: quality.instruction, attempt: attempt + 1 },
      retry: { instruction: quality.instruction, attempt: attempt + 1, signature },
    };
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
/**
 * What the chat and the job step say when the types are wrong.
 *
 * Named as a distinct class from a bundle failure on purpose: "the build failed" sends the
 * model looking for a broken import, and the defect is a prop or a value that the bundler was
 * perfectly happy with.
 */
function typeCheckSummary(errors: BuildError[]): string {
  const first = errors[0];
  const rest = errors.length - 1;
  const where = first.file
    ? `${first.file}${first.line ? `:${first.line}` : ''}`
    : 'the generated code';
  return `The site bundles, but it does not type-check: ${where} — ${first.message}${
    rest > 0 ? ` (and ${rest} more)` : ''
  }`;
}

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
