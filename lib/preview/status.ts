import { LIVE_MODE_LOCKED_REASON } from './labels';
import { previewBuildTable, getProjectPreviewFields } from './db';
import { signedPreviewUrl } from './url';
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
};

export async function getPreviewStatus(projectId: string, userId: string): Promise<PublicPreviewStatus | null> {
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
  const lockedLive = project.previewMode === 'LIVE_SANDBOX';
  const preparing = current?.status === 'BUILDING' || current?.status === 'PENDING';

  const previewUrl =
    lastReady?.status === 'READY'
      ? await signedPreviewUrl({ projectId, userId })
      : null;

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
    preparing,
  };
}
