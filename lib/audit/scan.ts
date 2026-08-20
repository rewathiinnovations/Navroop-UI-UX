import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import type { StackId } from '@/lib/stacks';
import { runA11yAudit } from './a11y';
import { runAiReview } from './ai-review';
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

export async function runCodeScan(input: {
  stack: StackId;
  files: FileSnapshotEntry[];
  previewUrl: string | null;
  sandbox: SandboxRunner | null;
  seoFindings: SeoFinding[];
  directionId?: string | null;
  /** Acting user — credential resolution must match the generation call (F-073). */
  userId: string | null;
}): Promise<{ findings: CodeFinding[]; metrics: CodeMetrics; signals: CodeScanSignals }> {
  const staticFindings = await runStaticAnalysis(input.stack, input.sandbox);
  const bundle = await runBundleMeasure(
    input.stack,
    input.sandbox,
    countRoutes(input.stack, input.files),
  );
  const a11y = await runA11yAudit(input.previewUrl, input.seoFindings);
  const beforeAi = [...staticFindings, ...bundle.findings, ...a11y];
  const ai = await runAiReview({
    stack: input.stack,
    directionId: input.directionId,
    files: input.files,
    staticFindings: beforeAi,
    userId: input.userId,
  });
  const findings = [...beforeAi, ...ai];
  return {
    findings,
    metrics: metricsFromFindings(findings, bundle.bundleKb ?? totalBundleKb([])),
    signals: {
      // `metrics` counts findings, and a check that never started contributes
      // none — indistinguishable from a clean result. These three say which
      // checks actually produced a verdict, so the collector can record only
      // those (F-705) with axe's real impacts (F-816).
      axeViolations: toolFailed(a11y, 'a11y') ? null : axeImpactsFromFindings(a11y),
      tsErrors: toolFailed(staticFindings, 'typescript')
        ? null
        : staticFindings.filter((row) => row.category === 'typescript' && row.status !== 'pass')
            .length,
      buildOk: bundle.ran ? !bundle.findings.some((row) => row.id === 'bundle:build-failed') : null,
    },
  };
}
