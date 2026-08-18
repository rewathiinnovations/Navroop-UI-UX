import { prisma } from '@/lib/db';
import type { PreviewBuildStatus, PreviewMode } from './types';

type PreviewBuildRow = {
  id: string;
  projectId: string;
  checkpointId: string;
  status: PreviewBuildStatus;
  mode: PreviewMode;
  storagePrefix: string | null;
  entryPath: string;
  isSpa: boolean;
  fileCount: number;
  totalBytes: number;
  buildLog: string | null;
  error: string | null;
  builtAt: Date | null;
  createdAt: Date;
};

type PreviewBuildDelegate = {
  create: (args: { data: Record<string, unknown> }) => Promise<PreviewBuildRow>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<PreviewBuildRow>;
  findMany: (args: Record<string, unknown>) => Promise<PreviewBuildRow[]>;
  findUnique: (args: { where: { id: string } }) => Promise<PreviewBuildRow | null>;
  findFirst: (args: Record<string, unknown>) => Promise<PreviewBuildRow | null>;
  delete: (args: { where: { id: string } }) => Promise<PreviewBuildRow>;
};

export function previewBuildTable() {
  return (prisma as unknown as { previewBuild: PreviewBuildDelegate }).previewBuild;
}

export async function setProjectPreviewFields(
  projectId: string,
  input: {
    previewMode: PreviewMode;
    activePreviewBuildId: string | null;
    fromBuildId?: string;
  },
) {
  if (input.activePreviewBuildId) {
    const incomingId = input.activePreviewBuildId;
    await prisma.$executeRaw`
      UPDATE "Project"
      SET
        "previewMode" = ${input.previewMode}::"PreviewMode",
        "activePreviewBuildId" = ${incomingId},
        "updatedAt" = NOW()
      WHERE id = ${projectId} AND "deletedAt" IS NULL
        AND (
          "activePreviewBuildId" IS NULL
          OR "activePreviewBuildId" = ${incomingId}
          OR EXISTS (
            SELECT 1
            FROM "PreviewBuild" incoming
            LEFT JOIN "PreviewBuild" current ON current.id = "Project"."activePreviewBuildId"
            WHERE incoming.id = ${incomingId}
              AND (current.id IS NULL OR incoming."createdAt" >= current."createdAt")
          )
        )
    `;
    return;
  }

  if (input.fromBuildId) {
    const fromBuildId = input.fromBuildId;
    await prisma.$executeRaw`
      UPDATE "Project"
      SET
        "previewMode" = ${input.previewMode}::"PreviewMode",
        "activePreviewBuildId" = NULL,
        "updatedAt" = NOW()
      WHERE id = ${projectId} AND "deletedAt" IS NULL
        AND (
          "activePreviewBuildId" IS NULL
          OR "activePreviewBuildId" = ${fromBuildId}
        )
    `;
    return;
  }

  await prisma.$executeRaw`
    UPDATE "Project"
    SET
      "previewMode" = ${input.previewMode}::"PreviewMode",
      "activePreviewBuildId" = ${input.activePreviewBuildId},
      "updatedAt" = NOW()
    WHERE id = ${projectId} AND "deletedAt" IS NULL
  `;
}

export async function getProjectPreviewFields(projectId: string) {
  const rows = await prisma.$queryRaw<
    Array<{
      previewMode: PreviewMode;
      activePreviewBuildId: string | null;
      stack: string;
      previewUrl: string | null;
    }>
  >`
    SELECT "previewMode", "activePreviewBuildId", "stack"::text AS stack, "previewUrl"
    FROM "Project"
    WHERE id = ${projectId} AND "deletedAt" IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export type { PreviewBuildRow };
