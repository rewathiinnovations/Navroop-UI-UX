-- AlterEnum
CREATE TYPE "SandboxStatus" AS ENUM ('NONE', 'BOOTING', 'READY', 'DEAD', 'FAILED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "sandboxStatus" "SandboxStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Project" ADD COLUMN "sandboxStartedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "sandboxLastUsedAt" TIMESTAMP(3);

-- Existing rows with a stored sandbox id are treated as unknown/dead until probed.
UPDATE "Project" SET "sandboxStatus" = 'DEAD' WHERE "sandboxId" IS NOT NULL AND "sandboxStatus" = 'NONE';

-- CreateIndex
CREATE INDEX "Project_sandboxStatus_sandboxLastUsedAt_idx" ON "Project"("sandboxStatus", "sandboxLastUsedAt");
