-- Static preview builds. Viewing a result must not keep a sandbox alive.

CREATE TYPE "PreviewBuildStatus" AS ENUM ('PENDING', 'BUILDING', 'READY', 'FAILED');
CREATE TYPE "PreviewMode" AS ENUM ('STATIC', 'LIVE_SANDBOX');

CREATE TABLE "PreviewBuild" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "status" "PreviewBuildStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "PreviewMode" NOT NULL,
    "storagePrefix" TEXT,
    "entryPath" TEXT NOT NULL DEFAULT 'index.html',
    "isSpa" BOOLEAN NOT NULL DEFAULT false,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "buildLog" TEXT,
    "error" TEXT,
    "builtAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewBuild_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PreviewBuild_projectId_createdAt_idx" ON "PreviewBuild"("projectId", "createdAt");

ALTER TABLE "PreviewBuild" ADD CONSTRAINT "PreviewBuild_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Project" ADD COLUMN "activePreviewBuildId" TEXT;
ALTER TABLE "Project" ADD COLUMN "previewMode" "PreviewMode" NOT NULL DEFAULT 'STATIC';
