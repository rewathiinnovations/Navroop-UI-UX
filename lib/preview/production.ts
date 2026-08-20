import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { upload } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { buildStaticPreview } from './build';
import { previewBuildTable, setProjectPreviewFields } from './db';
import type { BuildStaticPreviewDeps, PreviewBuildStore } from './types';

function prismaStore(): PreviewBuildStore {
  return {
    async createBuilding(input) {
      const created = await previewBuildTable().create({
        data: {
          projectId: input.projectId,
          checkpointId: input.checkpointId,
          status: 'BUILDING',
          mode: input.mode,
        },
      });
      return { id: created.id, status: created.status, mode: created.mode };
    },
    async markFailed(id, input) {
      await previewBuildTable().update({
        where: { id },
        data: {
          status: 'FAILED',
          mode: input.mode,
          error: input.error ?? null,
          buildLog: input.buildLog ?? null,
          // A half-finished upload leaves objects under this prefix; recording
          // it is the only way the pruner can reclaim them (F-146).
          ...(input.storagePrefix ? { storagePrefix: input.storagePrefix } : {}),
          builtAt: new Date(),
        },
      });
    },
    async markReady(id, input) {
      await previewBuildTable().update({
        where: { id },
        data: {
          status: 'READY',
          mode: input.mode,
          storagePrefix: input.storagePrefix,
          entryPath: input.entryPath,
          isSpa: input.isSpa,
          fileCount: input.fileCount,
          totalBytes: input.totalBytes,
          buildLog: input.buildLog ?? null,
          builtAt: new Date(),
          error: null,
        },
      });
    },
    setProjectPreview: setProjectPreviewFields,
  };
}

export async function createProductionPreviewDeps(
  projectId: string,
): Promise<BuildStaticPreviewDeps | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, lastCode: true },
  });
  if (!project) return null;

  return {
    stack: project.stack,
    files: getCurrentProjectFiles({ lastCode: project.lastCode }),
    store: prismaStore(),
    storage: {
      async upload(input) {
        await upload(input.body, {
          key: input.key,
          contentType: input.contentType,
          contentEncoding: input.gzip ? 'gzip' : undefined,
        });
        await adjustStorageBytes(input.body.byteLength);
      },
    },
  };
}

/**
 * Build the served static preview for a checkpoint. Runs in this process with
 * esbuild — no sandbox to boot, so this can be called whenever a checkpoint is
 * written rather than only while a VM happens to be alive.
 */
export async function buildPreviewForProject(projectId: string, checkpointId: string) {
  const deps = await createProductionPreviewDeps(projectId);
  if (!deps) {
    return { ok: false as const, skipped: true as const, reason: 'project_not_found' };
  }
  return buildStaticPreview(projectId, checkpointId, deps);
}
