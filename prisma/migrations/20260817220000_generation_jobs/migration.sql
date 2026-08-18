-- Durable GenerationJob. Does not touch BackupRun, Template, CustomDomain, Integration, Plan, or lock/presence columns.

CREATE TYPE "JobKind" AS ENUM ('PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT', 'AUDIT');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED');

ALTER TABLE "Project" ADD COLUMN "activeJobId" TEXT;

CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "ownerInstance" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "inputPrompt" TEXT,
    "planVersion" INTEGER,
    "partialFiles" JSONB,
    "filesWritten" INTEGER NOT NULL DEFAULT 0,
    "lastStep" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestId" TEXT,
    "idempotencyKey" TEXT,
    "creditsChargedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GenerationJob_projectId_createdAt_idx" ON "GenerationJob"("projectId", "createdAt");
CREATE INDEX "GenerationJob_status_heartbeatAt_idx" ON "GenerationJob"("status", "heartbeatAt");

CREATE UNIQUE INDEX one_active_job_per_project
  ON "GenerationJob" ("projectId")
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX generation_job_project_idempotency_key
  ON "GenerationJob" ("projectId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_activeJobId_fkey" FOREIGN KEY ("activeJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
