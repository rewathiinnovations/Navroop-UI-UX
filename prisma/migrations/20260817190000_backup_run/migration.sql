-- CreateTable
CREATE TABLE IF NOT EXISTS "BackupRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BackupRun_kind_startedAt_idx" ON "BackupRun"("kind", "startedAt");
