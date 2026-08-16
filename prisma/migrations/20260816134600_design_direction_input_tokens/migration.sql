-- Existing Project.stack rows are NOT rewritten. Only the column default changes.
ALTER TABLE "Project" ALTER COLUMN "stack" SET DEFAULT 'NEXTJS';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "designDirection" TEXT NOT NULL DEFAULT 'minimal';

-- AlterTable
ALTER TABLE "GenerationEvent" ADD COLUMN "inputTokens" INTEGER;
