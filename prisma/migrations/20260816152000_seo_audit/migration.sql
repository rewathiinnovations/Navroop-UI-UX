-- CreateTable
CREATE TABLE "SeoAudit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoAudit_projectId_idx" ON "SeoAudit"("projectId");

-- CreateIndex
CREATE INDEX "SeoAudit_projectId_scannedAt_idx" ON "SeoAudit"("projectId", "scannedAt");

-- AddForeignKey
ALTER TABLE "SeoAudit" ADD CONSTRAINT "SeoAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
