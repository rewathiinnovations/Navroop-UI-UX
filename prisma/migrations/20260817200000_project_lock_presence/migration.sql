-- Project lock + presence + stale-view version. Does not touch BackupRun.

ALTER TABLE "Project" ADD COLUMN "lockedById" TEXT;
ALTER TABLE "Project" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "lockExpiresAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "lockReason" TEXT;
ALTER TABLE "Project" ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ProjectPresence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectPresence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectPresence_projectId_userId_key" ON "ProjectPresence"("projectId", "userId");
CREATE INDEX "ProjectPresence_projectId_lastSeenAt_idx" ON "ProjectPresence"("projectId", "lastSeenAt");
CREATE INDEX "Project_lockedById_lockExpiresAt_idx" ON "Project"("lockedById", "lockExpiresAt");

ALTER TABLE "Project" ADD CONSTRAINT "Project_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectPresence" ADD CONSTRAINT "ProjectPresence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectPresence" ADD CONSTRAINT "ProjectPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
