-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CustomDomainStatus" AS ENUM ('PENDING_DNS', 'VERIFYING', 'SSL_PENDING', 'ACTIVE', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomDomainPath" AS ENUM ('A', 'B');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomDomain" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" "CustomDomainStatus" NOT NULL DEFAULT 'PENDING_DNS',
    "verifyToken" TEXT NOT NULL,
    "expectedTarget" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sslIssuedAt" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "path" "CustomDomainPath" NOT NULL DEFAULT 'A',
    "cloudflareZoneId" TEXT,
    "nameservers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomDomain_hostname_key" ON "CustomDomain"("hostname");
CREATE INDEX IF NOT EXISTS "CustomDomain_status_lastCheckedAt_idx" ON "CustomDomain"("status", "lastCheckedAt");
CREATE INDEX IF NOT EXISTS "CustomDomain_deploymentId_idx" ON "CustomDomain"("deploymentId");
CREATE INDEX IF NOT EXISTS "CustomDomain_workspaceId_idx" ON "CustomDomain"("workspaceId");

ALTER TABLE "CustomDomain" DROP CONSTRAINT IF EXISTS "CustomDomain_deploymentId_fkey";
ALTER TABLE "CustomDomain" ADD CONSTRAINT "CustomDomain_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomDomain" DROP CONSTRAINT IF EXISTS "CustomDomain_workspaceId_fkey";
ALTER TABLE "CustomDomain" ADD CONSTRAINT "CustomDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
