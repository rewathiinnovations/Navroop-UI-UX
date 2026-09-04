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
  activeBuildId: string | null;
  preparing: boolean;
  /** False when no distinct preview origin exists, so nothing can open top-level. */
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
  // Live sandbox mode no longer exists — every project previews the same way, so
  // this is false for every project. `liveReason` went with it: nothing could set
  // `lockedLive`, so the field was a string no branch could ever produce (F-154).
  const lockedLive = false;
  const preparing = current?.status === 'BUILDING' || current?.status === 'PENDING';

  const originConfigured = (await previewStaticBaseUrl()) != null;
  // One rule, one place: the URL points at the build `/preview-static` actually
  // serves — `activePreviewBuildId`, which is only ever a READY build (F-147).
  // Deriving it from "any READY build" instead handed out links the route
  // answered 404 after a failed rebuild. And the signed URL is an anonymous
  // capability, so it is only minted for a caller allowed to mint (F-148); a
  // reader who is not gets the status without it.
  const previewUrl =
    options.mayMint && active?.status === 'READY'
      ? await signedPreviewUrl({ projectId, userId: options.userId })
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
