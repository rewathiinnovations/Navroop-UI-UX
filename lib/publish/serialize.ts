import type { Deployment, DeploymentKind, DeploymentStatus } from '@/generated/prisma';
import { urlForSlug } from './slug';

export type PublicDeployment = {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: DeploymentKind;
  status: DeploymentStatus;
  slug: string;
  url: string | null;
  expectedUrl: string;
  progressStep: string | null;
  lastError: string | null;
  lastRequestId: string | null;
  buildLogUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasPassword: boolean;
  publishedBy: { id: string; name: string } | null;
  projectName?: string;
  canonicalUrl: string;
};

export function serializeDeployment(
  row: Deployment & {
    publishedBy?: { id: string; name: string } | null;
    project?: { name: string } | null;
    progressStep?: string | null;
  },
  root: string,
  opts?: { canonicalHost?: string | null },
): PublicDeployment {
  const expectedUrl = root
    ? urlForSlug(row.slug.startsWith('pending-') ? 'site' : row.slug, row.kind, root)
    : row.url || '';
  const canonicalUrl = opts?.canonicalHost ? `https://${opts.canonicalHost}` : expectedUrl;
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    status: row.status,
    slug: row.slug,
    url: opts?.canonicalHost ? canonicalUrl : row.url,
    expectedUrl,
    canonicalUrl,
    progressStep: row.progressStep ?? null,
    lastError: row.lastError,
    lastRequestId: row.lastRequestId,
    buildLogUrl: row.buildLogUrl,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasPassword: Boolean(row.passwordHash),
    publishedBy: row.publishedBy ? { id: row.publishedBy.id, name: row.publishedBy.name } : null,
    projectName: row.project?.name,
  };
}
