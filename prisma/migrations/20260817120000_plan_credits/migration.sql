-- Plan + credit ledger. Merge onto existing Workspace (keep storageBytes).
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "monthlyCredits" INTEGER NOT NULL,
    "maxProjects" INTEGER NOT NULL,
    "maxLiveSites" INTEGER NOT NULL,
    "maxPreviewSites" INTEGER NOT NULL,
    "maxMembers" INTEGER NOT NULL,
    "maxConcurrentSandboxes" INTEGER NOT NULL,
    "checkpointRetentionDays" INTEGER NOT NULL,
    "storageBytesLimit" BIGINT NOT NULL,
    "allowCustomDomain" BOOLEAN NOT NULL DEFAULT false,
    "allowGithubSync" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

ALTER TABLE "Workspace" ADD COLUMN "planId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "creditsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "creditsPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Workspace" ADD COLUMN "memberMonthlyCreditCap" INTEGER;
ALTER TABLE "Workspace" ADD COLUMN "generationPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "creditAlert80Sent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "action" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditLedger_workspaceId_createdAt_idx" ON "CreditLedger"("workspaceId", "createdAt");
CREATE INDEX "CreditLedger_workspaceId_userId_createdAt_idx" ON "CreditLedger"("workspaceId", "userId", "createdAt");

ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
