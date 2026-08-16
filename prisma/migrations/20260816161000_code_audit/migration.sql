-- CreateTable
CREATE TABLE "CodeAudit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeAudit_projectId_idx" ON "CodeAudit"("projectId");

-- CreateIndex
CREATE INDEX "CodeAudit_projectId_scannedAt_idx" ON "CodeAudit"("projectId", "scannedAt");

-- AddForeignKey
ALTER TABLE "CodeAudit" ADD CONSTRAINT "CodeAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
