DO $$ BEGIN
  CREATE TYPE "IntegrationKind" AS ENUM ('GITHUB_DEPLOY', 'CLOUDFLARE', 'COOLIFY');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "IntegrationStatus" AS ENUM ('DISCONNECTED', 'PENDING', 'CONNECTED', 'ERROR');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "config" JSONB NOT NULL,
    "secrets" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Integration_workspaceId_kind_key" ON "Integration"("workspaceId", "kind");
CREATE INDEX IF NOT EXISTS "Integration_workspaceId_status_idx" ON "Integration"("workspaceId", "status");

ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_workspaceId_fkey";
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_connectedById_fkey";
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
