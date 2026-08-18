-- Multi-provider sandbox configs (e2b | modal | daytona). Credentials encrypted.

CREATE TABLE "SandboxProviderConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "secrets" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "creditType" TEXT NOT NULL,
    "creditTotalUsd" DECIMAL(12,4),
    "creditRemainingUsd" DECIMAL(12,4),
    "creditResetsAt" TIMESTAMP(3),
    "monthlyBudgetUsd" DECIMAL(12,4),
    "monthlyMinutesLimit" INTEGER,
    "minutesUsed" INTEGER NOT NULL DEFAULT 0,
    "spendUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxProviderConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Project" ADD COLUMN "sandboxProviderConfigId" TEXT;
ALTER TABLE "GenerationJob" ADD COLUMN "providerConfigId" TEXT;

ALTER TABLE "Project" ADD CONSTRAINT "Project_sandboxProviderConfigId_fkey"
  FOREIGN KEY ("sandboxProviderConfigId") REFERENCES "SandboxProviderConfig"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_providerConfigId_fkey"
  FOREIGN KEY ("providerConfigId") REFERENCES "SandboxProviderConfig"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
