import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { previewBuildTable, getProjectPreviewFields } from './db';
import { publicPreviewViewHref } from './public-view';
import { issuePreviewToken } from './token';
import { previewStaticBaseUrl } from './url';
import type { PreviewBuildStatus, PreviewMode } from './types';

export type PublicPreviewStatus = {
  mode: PreviewMode;
  status: PreviewBuildStatus | null;
  previewUrl: string | null;
  lastReadyUrl: string | null;
  buildLog: string | null;
  error: string | null;
  lockedLive: boolean;
  activeBuildId: string | null;
  preparing: boolean;
  /** False when no distinct preview origin exists (SEO/audit still use it). */
  originConfigured: boolean;
};

export async function getPreviewStatus(
  projectId: string,
  options: { userId: string; mayMint: boolean },
): Promise<PublicPreviewStatus | null> {
  const project = await getProjectPreviewFields(projectId);
  if (!project) return null;

  const table = previewBuildTable();
  const active = project.activePreviewBuildId
    ? await table.findUnique({ where: { id: project.activePreviewBuildId } })
    : null;
  const latest = await table.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });

  const current = latest ?? active;
  const lockedLive = false;
  const preparing = current?.status === 'BUILDING' || current?.status === 'PENDING';

  const originConfigured = (await previewStaticBaseUrl()) != null;
  const hasFiles = Object.keys(getCurrentProjectFiles({ lastCode: project.lastCode })).length > 0;
  const previewUrl =
    options.mayMint && hasFiles
      ? publicPreviewViewHref({
          projectId,
          token: issuePreviewToken({ projectId, userId: options.userId }),
        })
      : null;

  return {
    mode: project.previewMode,
    status: current?.status ?? null,
    previewUrl,
    lastReadyUrl: previewUrl,
    buildLog: current?.buildLog ?? null,
    error: current?.error ?? null,
    lockedLive,
    activeBuildId: project.activePreviewBuildId,
    originConfigured,
    preparing,
  };
}
