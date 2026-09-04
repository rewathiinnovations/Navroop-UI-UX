import { prisma } from '@/lib/db';
import { servedProjectFiles } from '@/lib/checkpoints/served-files';
import type { PublicPreviewSite } from './public-view';
import { checkPreviewToken } from './token';

export type { PublicPreviewSite };

/**
 * Anonymous, read-only site for `/preview-view`. Same files as the workspace
 * files API (checkpoint preview or lastCode). A missing/invalid/expired token
 * is indistinguishable from an empty project — no session, no leak.
 */
export async function loadPublicPreviewSite(input: {
  projectId: string;
  token: string | null | undefined;
}): Promise<PublicPreviewSite | null> {
  const verified = checkPreviewToken(input.token, input.projectId);
  if (!verified.ok) return null;

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deletedAt: null },
    select: {
      id: true,
      stack: true,
      lastCode: true,
      designDirection: true,
    },
  });
  if (!project) return null;

  const served = await servedProjectFiles(project);
  if (!served.ok || Object.keys(served.files).length === 0) return null;

  return {
    ok: true,
    stack: project.stack,
    designDirection: project.designDirection,
    files: served.files,
  };
}
