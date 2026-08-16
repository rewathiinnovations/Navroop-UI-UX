import type { StackId } from '@/lib/stacks';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';

export type SeoSeverity = 'pass' | 'low' | 'medium' | 'high';

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
  fixed?: boolean;
};

export type LiveDocument = {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
};

export type LiveText = {
  status: number;
  text: string;
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
