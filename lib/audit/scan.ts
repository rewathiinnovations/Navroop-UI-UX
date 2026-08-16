import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import type { StackId } from '@/lib/stacks';
import { runA11yAudit } from './a11y';
import { runAiReview } from './ai-review';
import { runBundleMeasure, totalBundleKb } from './bundle';
import { metricsFromFindings } from './findings';
import { runStaticAnalysis } from './static';
import type { CodeFinding, CodeMetrics, SandboxRunner } from './types';
import type { SeoFinding } from '@/lib/seo/types';

function countRoutes(stack: StackId, files: FileSnapshotEntry[]): number {
  const paths = files.map((file) => file.path.replace(/\\/g, '/'));
  if (stack === 'NEXTJS') {
    return paths.filter((path) => /(^|\/)(app\/.*\/)?page\.(t|j)sx$/.test(path) || /(^|\/)pages\/.+\.(t|j)sx$/.test(path)).length;
  }
  if (stack === 'ASTRO') {
    return paths.filter((path) => /(^|\/)src\/pages\/.+\.(astro|md|mdx)$/.test(path)).length;
  }
  if (stack === 'SVELTE') {
    return paths.filter((path) => /(^|\/)src\/routes\/.*\+page\.svelte$/.test(path)).length;
  }
  if (stack === 'VUE') {
    return paths.filter((path) => /(^|\/)src\/(views|pages)\/.+\.vue$/.test(path)).length;
  }
  if (stack === 'REACT') {
    return Math.max(1, paths.filter((path) => /(^|\/)src\/(pages|routes)\/.+\.(t|j)sx$/.test(path)).length);
  }
  return 1;
}

export async function runCodeScan(input: {
  stack: StackId;
  files: FileSnapshotEntry[];
  previewUrl: string | null;
  sandbox: SandboxRunner | null;
  seoFindings: SeoFinding[];
  directionId?: string | null;
}): Promise<{ findings: CodeFinding[]; metrics: CodeMetrics }> {
  const staticFindings = await runStaticAnalysis(input.stack, input.sandbox);
  const bundle = await runBundleMeasure(input.stack, input.sandbox, countRoutes(input.stack, input.files));
  const a11y = await runA11yAudit(input.previewUrl, input.seoFindings);
  const beforeAi = [...staticFindings, ...bundle.findings, ...a11y];
  const ai = await runAiReview({
    stack: input.stack,
    directionId: input.directionId,
    files: input.files,
    staticFindings: beforeAi,
  });
  const findings = [...beforeAi, ...ai];
  return {
    findings,
    metrics: metricsFromFindings(findings, bundle.bundleKb ?? totalBundleKb([])),
  };
}
