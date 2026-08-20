import type { StackId } from '@/lib/stacks';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';

// A code finding is a real verdict on the code: a defect (low/medium/high) or a
// pass. It has no "could not check" state — that belongs to the SEO audit, which
// fetches a live preview (F-755); an unrunnable code check is a `tool`-category
// finding, not a severity. Kept an explicit union rather than aliasing
// `SeoSeverity` so SEO's `info` cannot silently leak into code-audit ordering,
// panels, and the `asCodeFindings` validator, none of which model it.
export type CodeSeverity = 'pass' | 'low' | 'medium' | 'high';

export type CodeCategory =
  'typescript' | 'lint' | 'dependencies' | 'dead-code' | 'bundle' | 'a11y' | 'ai-review' | 'tool';

export type CodeFinding = {
  id: string;
  category: CodeCategory;
  status: CodeSeverity;
  title: string;
  detail: string;
  fixable: boolean;
  ignored: boolean;
  /**
   * F-820: this used to be `fixed: boolean`, stamped by the Fix action *before*
   * any generation had run — the panel claimed an issue was fixed while the code
   * was untouched, and the next scan re-reported it as new. What the server
   * actually knows is when a fix was asked for; whether the build landed is the
   * next scan's answer.
   */
  fixRequestedAt?: string;
  /**
   * The a11y category only: axe's own `impact`, kept beside the four-value
   * `status` it is mapped onto. `mapAxeImpact` collapses moderate and minor
   * into `low`, so the display severity cannot be turned back into the impact
   * the quality score weights by — and the collector used to invent `moderate`
   * for every violation because nothing carried the real one (F-816).
   */
  impact?: string;
  filePath?: string;
  line?: number;
  selector?: string;
};

export type CodeMetrics = {
  bundleKb: number | null;
  tsErrors: number;
  lintErrors: number;
  a11yViolations: number;
  unusedDeps: number;
};

export type PublicCodeAudit = {
  id: string;
  projectId: string;
  findings: CodeFinding[];
  metrics: CodeMetrics;
  scannedAt: string;
};

export type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
};

export type SandboxRunner = {
  runCommand: (command: string) => Promise<SandboxCommandResult>;
  writeFile?: (path: string, content: string) => Promise<void>;
};

export type BundleAsset = {
  path: string;
  kind: 'js' | 'css' | 'image' | 'other';
  gzipKb: number;
  rawKb: number;
};

export type BundleMeasure = {
  stack: StackId;
  ok: boolean;
  error: string | null;
  assets: BundleAsset[];
  routeCount: number;
};

export type AxeNode = {
  target: string[];
};

export type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: AxeNode[];
};

export type CodeScanInput = {
  stack: StackId;
  files: FileSnapshotEntry[];
  previewUrl: string | null;
  sandbox: SandboxRunner | null;
};
