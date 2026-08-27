import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import type { StackId } from '@/lib/stacks';
import { a11yNeedsScanFinding, runA11yAudit } from './a11y';
import { aiReviewNeedsScanFinding, runAiReview, type AiReviewUsage } from './ai-review';
import { runBundleMeasure, totalBundleKb } from './bundle';
import { axeImpactsFromFindings, metricsFromFindings } from './findings';
import { toolFailed } from './static/tool-fail';
import { runStaticAnalysis } from './static';
import type { CodeFinding, CodeMetrics, SandboxRunner } from './types';
import type { SeoFinding } from '@/lib/seo/types';

function countRoutes(stack: StackId, files: FileSnapshotEntry[]): number {
  const paths = files.map((file) => file.path.replace(/\\/g, '/'));
  if (stack === 'NEXTJS') {
    return paths.filter(
      (path) =>
        /(^|\/)(app\/.*\/)?page\.(t|j)sx$/.test(path) || /(^|\/)pages\/.+\.(t|j)sx$/.test(path),
    ).length;
  }
  if (stack === 'REACT') {
    return Math.max(
      1,
      paths.filter((path) => /(^|\/)src\/(pages|routes)\/.+\.(t|j)sx$/.test(path)).length,
    );
  }
  return 1;
}

/**
 * What the scan is entitled to assert. `null` means the check did not run, and
 * the quality collector records nothing for it rather than a perfect score.
 */
export type CodeScanSignals = {
  axeViolations: Array<{ impact: string | null }> | null;
  tsErrors: number | null;
  buildOk: boolean | null;
};

/**
 * How much of the audit to run.
 *
 * `static` is everything that costs nothing and finishes immediately: the file-level
 * analysis and the bundle measure. Neither leaves this process — `runStaticAnalysis`
 * and `runBundleMeasure` take a `SandboxRunner` that is always null here, so they
 * report "no build runner" and skip, and there is nothing to pay for either way.
 *
 * On an instance with no runner that leaves `checksRun` at zero: a `static` scan there
 * learns nothing about the code and its whole output is six `tool` rows saying so. That
 * is a real outcome and the caller is expected to act on it — `performCodeAudit` stores
 * no `CodeAudit` row for it — rather than to store the rows as if they were an audit.
 *
 * `full` adds the two that are neither: `runA11yAudit` forks a Chromium through
 * `withHeadlessBrowser`, and `runAiReview` sends up to 40 000 input tokens of the
 * user's source to a paid provider. Those are the checks that made an automatic scan
 * after every build cost real money and need a browser the production image does not
 * ship — so they run only where a person asked for them and is metered for it.
 *
 * The split is clean because the four halves never fed each other: only `runAiReview`
 * reads earlier findings, and only to decide whether to bail out and which files to
 * skip. Nothing static depends on axe or on the model.
 */
export type CodeScanDepth = 'static' | 'full';

export type CodeScanResult = {
  findings: CodeFinding[];
  metrics: CodeMetrics;
  signals: CodeScanSignals;
  /**
   * What the AI review spent, for the caller to record. Null on the `static` depth
   * (no call was made) and on a `full` run that skipped or never reached the provider.
   */
  aiUsage: AiReviewUsage | null;
  /**
   * How many of the audit's checks reached a verdict about the generated code.
   *
   * Zero means this run learned nothing: every check either had nothing to run on or
   * reported that it could not run, and the `findings` are entirely `tool` rows about the
   * installation. Counting findings cannot tell that apart from a flawless project —
   * both are zero defects — which is how a `static` scan with no build runner came to
   * store six "could not run" rows plus metrics reading `0` across the board, and the
   * Quality panel presented that as a clean bill of health. The caller stores a row only
   * when this is above zero; see {@link checksWithVerdict} for what counts.
   */
  checksRun: number;
};

/** The four checks `runStaticAnalysis` dispatches, named the way `toolFailedId` names them. */
const STATIC_CHECKS = ['typescript', 'lint', 'dependencies', 'dead-code'] as const;

/**
 * How many of the four static checks came back with something to say about the code.
 *
 * Two ways to produce none. `runStaticAnalysis` dispatches nothing at all for
 * `STATIC_HTML` (there is no node tooling to point at a folder of .html), and otherwise
 * every check that could not run files a `tool:<check>` row — which is what a null
 * `SandboxRunner` gets you for all four at once. A check that ran and found nothing files
 * nothing, so the absence of its `tool` row is exactly "it ran": that asymmetry is the
 * only thing separating a clean project from an instance with no build runner.
 *
 * That asymmetry is exact on the path this deployment takes and optimistic past it. Once a
 * runner exists the sub-tools file under their own names — `runDependencyChecks` reports
 * `tool:depcheck` and `tool:npm-audit`, never `tool:dependencies` — so a dependency check
 * whose halves both failed reads here as having reached a verdict. That over-counts
 * `checksRun` and never under-counts it, so its only effect is to let a row through, and it
 * is unreachable while `performCodeAudit` passes `sandbox = null`. Whoever gives the audit a
 * runner has to revisit this function, not just this comment.
 *
 * The `STATIC_HTML` arm mirrors `runStaticAnalysis`'s own `skipNode`, so the two have to
 * move together; `tests/unit/quality-scan-verdict-and-ledger.test.ts` pins both halves —
 * that the stack really does dispatch nothing even when handed a working runner, and that
 * `checksRun` is therefore zero for it — rather than trusting this copy of the condition.
 */
function checksWithVerdict(stack: StackId, staticFindings: CodeFinding[]): number {
  if (stack === 'STATIC_HTML') return 0;
  return STATIC_CHECKS.filter((check) => !toolFailed(staticFindings, check)).length;
}

export async function runCodeScan(input: {
  stack: StackId;
  files: FileSnapshotEntry[];
  previewUrl: string | null;
  sandbox: SandboxRunner | null;
  seoFindings: SeoFinding[];
  directionId?: string | null;
  /** Acting user — credential resolution must match the generation call (F-073). */
  userId: string | null;
  /** Defaults to the full audit: a new caller has to opt *out* of a check, never into one. */
  depth?: CodeScanDepth;
}): Promise<CodeScanResult> {
  const full = (input.depth ?? 'full') === 'full';
  const staticFindings = await runStaticAnalysis(input.stack, input.sandbox);
  const bundle = await runBundleMeasure(
    input.stack,
    input.sandbox,
    countRoutes(input.stack, input.files),
  );
  // A skipped check is announced, never omitted. The panel renders whatever findings
  // the row carries, so leaving these out would show the static half as a complete
  // audit — the reader could not tell a page with no accessibility defects from a page
  // nobody looked at, which is worse than an empty panel.
  const a11y = full
    ? await runA11yAudit(input.previewUrl, input.seoFindings)
    : [a11yNeedsScanFinding()];
  const beforeAi = [...staticFindings, ...bundle.findings, ...a11y];
  const ai = full
    ? await runAiReview({
        stack: input.stack,
        directionId: input.directionId,
        files: input.files,
        staticFindings: beforeAi,
        userId: input.userId,
      })
    : { findings: [aiReviewNeedsScanFinding()], usage: null };
  const findings = [...beforeAi, ...ai.findings];
  // `full &&` rather than a findings test for both of these: at `static` depth neither
  // check is started, and the row that says so carries a `:needs-scan` id on purpose, so
  // `toolFailed` — which means "ran and failed" — would answer false for a check nobody
  // began. The AI review additionally has to have reached the provider: it returns no
  // findings and no usage when it skips itself (twenty static findings already, or no
  // source file worth sending), and a review that never asked has no verdict to offer.
  // `ai.usage` is non-null exactly when a call went out, including one that was billed and
  // then failed — hence the `toolFailed` test beside it.
  const a11yRan = full && !toolFailed(a11y, 'a11y');
  const aiRan = full && ai.usage !== null && !toolFailed(ai.findings, 'ai-review');
  return {
    findings,
    metrics: metricsFromFindings(findings, bundle.bundleKb ?? totalBundleKb([])),
    aiUsage: ai.usage,
    checksRun:
      checksWithVerdict(input.stack, staticFindings) +
      // `bundle.ran` is already "a build was attempted", false for a stack with no build
      // command and false with no runner to attempt it on.
      (bundle.ran ? 1 : 0) +
      (a11yRan ? 1 : 0) +
      (aiRan ? 1 : 0),
    signals: {
      // `metrics` counts findings, and a check that never started contributes
      // none — indistinguishable from a clean result. These three say which
      // checks actually produced a verdict, so the collector can record only
      // those (F-705) with axe's real impacts (F-816). A `static` run did not
      // start axe at all, so it asserts nothing about accessibility — the
      // needs-a-scan row deliberately carries a different id from the tool-failure
      // one, so this has to test the depth rather than the findings — which is what
      // `a11yRan` above already is, shared here so the two cannot drift apart.
      axeViolations: a11yRan ? axeImpactsFromFindings(a11y) : null,
      tsErrors: toolFailed(staticFindings, 'typescript')
        ? null
        : staticFindings.filter((row) => row.category === 'typescript' && row.status !== 'pass')
            .length,
      buildOk: bundle.ran ? !bundle.findings.some((row) => row.id === 'bundle:build-failed') : null,
    },
  };
}
