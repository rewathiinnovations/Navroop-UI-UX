-- AlterTable
ALTER TABLE "Project" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE "Project" ADD COLUMN "progressMessage" TEXT;
