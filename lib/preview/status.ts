import { LIVE_MODE_LOCKED_REASON } from './labels';
import { previewBuildTable, getProjectPreviewFields } from './db';
import { previewStaticBaseUrl, signedPreviewUrl } from './url';
import type { PreviewBuildStatus, PreviewMode } from './types';

export type PublicPreviewStatus = {
  mode: PreviewMode;
  status: PreviewBuildStatus | null;
  previewUrl: string | null;
  lastReadyUrl: string | null;
  buildLog: string | null;
  error: string | null;
  lockedLive: boolean;
  liveReason: string | null;
  activeBuildId: string | null;
  preparing: boolean;
  /** False when no distinct preview origin exists, so nothing can open top-level. */
  originConfigured: boolean;
};

export async function getPreviewStatus(
  projectId: string,
  userId: string,
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
  const lastReady = await table.findFirst({
    where: { projectId, status: 'READY' },
    orderBy: { createdAt: 'desc' },
  });

  const current = latest ?? active;
  // Live sandbox mode no longer exists — every project previews the same way.
  const lockedLive = false;
  const preparing = current?.status === 'BUILDING' || current?.status === 'PENDING';

  const originConfigured = (await previewStaticBaseUrl()) != null;
  const previewUrl =
    lastReady?.status === 'READY' ? await signedPreviewUrl({ projectId, userId }) : null;

  return {
    mode: project.previewMode,
    status: current?.status ?? null,
    previewUrl,
    lastReadyUrl: previewUrl,
    buildLog: current?.buildLog ?? null,
    error: current?.error ?? null,
    lockedLive,
    liveReason: lockedLive ? LIVE_MODE_LOCKED_REASON : null,
    activeBuildId: project.activePreviewBuildId,
    originConfigured,
    preparing,
  };
}
