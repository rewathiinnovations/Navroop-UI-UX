import type { SeoSeverity } from '@/lib/seo/types';
import type { StackId } from '@/lib/stacks';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';

export type CodeSeverity = SeoSeverity;

export type CodeCategory =
  | 'typescript'
  | 'lint'
  | 'dependencies'
  | 'dead-code'
  | 'bundle'
  | 'a11y'
  | 'ai-review'
  | 'tool';

export type CodeFinding = {
  id: string;
  category: CodeCategory;
  status: CodeSeverity;
  title: string;
  detail: string;
  fixable: boolean;
  ignored: boolean;
  fixed?: boolean;
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
