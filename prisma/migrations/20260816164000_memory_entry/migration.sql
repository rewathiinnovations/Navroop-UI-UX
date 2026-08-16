-- CreateTable
CREATE TABLE "MemoryEntry" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "projectId" TEXT,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "MemoryEntry_scope_projectId_status_idx" ON "MemoryEntry"("scope", "projectId", "status");

-- AddForeignKey
ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Default: extraction on unless an admin turns it off
INSERT INTO "AppSetting" ("key", "value", "updatedAt")
VALUES ('memoryExtractionEnabled', 'true', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
