-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "githubOrgInstallationId" TEXT;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DeploymentKind" AS ENUM ('PREVIEW', 'LIVE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'BUILDING', 'LIVE', 'FAILED', 'STOPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CoolifyServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "apiToken" TEXT NOT NULL,
    "serverIp" TEXT NOT NULL,
    "projectUuid" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxDeployments" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoolifyServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "kind" "DeploymentKind" NOT NULL,
    "status" "DeploymentStatus" NOT NULL,
    "slug" TEXT NOT NULL,
    "url" TEXT,
    "repoFullName" TEXT,
    "repoBranch" TEXT NOT NULL DEFAULT 'main',
    "commitSha" TEXT,
    "coolifyAppUuid" TEXT,
    "dnsRecordId" TEXT,
    "passwordHash" TEXT,
    "lastError" TEXT,
    "lastRequestId" TEXT,
    "buildLogUrl" TEXT,
    "progressStep" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_projectId_kind_key" ON "Deployment"("projectId", "kind");
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_slug_kind_key" ON "Deployment"("slug", "kind");
CREATE INDEX IF NOT EXISTS "Deployment_workspaceId_status_idx" ON "Deployment"("workspaceId", "status");

ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_projectId_fkey";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_workspaceId_fkey";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_serverId_fkey";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "CoolifyServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_publishedById_fkey";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
