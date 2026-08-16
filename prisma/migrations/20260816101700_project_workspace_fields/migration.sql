-- Preserve existing Project rows: rename generation/identity columns, then add product fields.

ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_userId_fkey";
DROP INDEX IF EXISTS "Project_userId_updatedAt_idx";

ALTER TABLE "Project" RENAME COLUMN "userId" TO "ownerId";
ALTER TABLE "Project" RENAME COLUMN "title" TO "name";
ALTER TABLE "Project" RENAME COLUMN "prompt" TO "initialPrompt";
ALTER TABLE "Project" RENAME COLUMN "screenshot" TO "thumbnailUrl";
ALTER TABLE "Project" RENAME COLUMN "status" TO "generationStatus";

ALTER TABLE "Project" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Project" ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");
