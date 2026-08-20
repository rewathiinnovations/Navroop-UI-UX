import type { Deployment } from '@/generated/prisma';
import { isPlaceholderSlug } from './naming';
import { urlForSlug } from './slug';
import type { PublicDeployment } from './types';

export function serializeDeployment(
  row: Deployment & {
    publishedBy?: { id: string; name: string } | null;
    project?: { name: string } | null;
    progressStep?: string | null;
  },
  root: string,
  opts?: { canonicalHost?: string | null },
): PublicDeployment {
  // No address until the slug is claimed. Substituting the literal `site` produced
  // `https://site.<zone>` — and `slugFromName` returns `site` for any name that
  // slugifies to nothing, so that host can be another project's live site. An empty
  // string is the honest answer and every consumer already renders one (a missing
  // root domain produces the same).
  const expectedUrl =
    root && !isPlaceholderSlug(row.slug) ? urlForSlug(row.slug, row.kind, root) : row.url || '';
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
