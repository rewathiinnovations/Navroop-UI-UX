import type { StackId } from '@/lib/stacks';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';

/**
 * `info` is "we could not evaluate this" — never the project's fault, so it
 * carries no fix and is excluded from the SEO score (F-755). A real defect is
 * low/medium/high; a real success is pass.
 */
export type SeoSeverity = 'pass' | 'info' | 'low' | 'medium' | 'high';

export type SeoCategory =
  | 'page-basics'
  | 'metadata'
  | 'open-graph'
  | 'structured-data'
  | 'robots'
  | 'sitemap'
  | 'indexing'
  | 'content-structure'
  | 'lighthouse';

export type SeoFinding = {
  id: string;
  category: SeoCategory;
  status: SeoSeverity;
  title: string;
  detail: string;
  fixable: boolean;
  ignored: boolean;
  /** F-820. See the note on `CodeFinding.fixRequestedAt`. */
  fixRequestedAt?: string;
};

export type LiveDocument = {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  /** The fetch never completed, so `status` is not a response the site sent. */
  unreachable: boolean;
};

export type LiveText = {
  status: number;
  text: string;
  /** The fetch never completed, so `status` is not a response the site sent. */
  unreachable: boolean;
};

export type SeoScanInput = {
  stack: StackId;
  files: FileSnapshotEntry[];
  previewUrl: string | null;
  live: LiveDocument | null;
  liveRobots: LiveText | null;
  liveSitemap: LiveText | null;
};

export type PublicSeoAudit = {
  id: string;
  projectId: string;
  findings: SeoFinding[];
  scannedAt: string;
};
