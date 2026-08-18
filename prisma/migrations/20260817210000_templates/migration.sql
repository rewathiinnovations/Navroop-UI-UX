-- Template library. Does not touch BackupRun, Project lock/presence, CustomDomain, Integration, Plan, or CreditLedger.

CREATE TABLE IF NOT EXISTS "Template" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "stack" "Stack" NOT NULL,
    "prompt" TEXT NOT NULL,
    "designDirection" TEXT,
    "thumbnailKey" TEXT,
    "previewUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "workspaceId" TEXT,
    "createdById" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Template_slug_key" ON "Template"("slug");
CREATE INDEX IF NOT EXISTS "Template_category_isActive_idx" ON "Template"("category", "isActive");

ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Template" ADD CONSTRAINT "Template_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
