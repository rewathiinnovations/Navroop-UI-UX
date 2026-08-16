-- CreateEnum
CREATE TYPE "ProjectPhase" AS ENUM ('PLANNING', 'BUILDING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ProjectPlanStatus" AS ENUM ('PENDING', 'APPROVED', 'SUPERSEDED');

-- AlterTable
-- New inserts default to PLANNING. Existing rows are backfilled to COMPLETE below.
ALTER TABLE "Project" ADD COLUMN "phase" "ProjectPhase" NOT NULL DEFAULT 'PLANNING';

-- Backfill: projects that already exist were already built.
UPDATE "Project" SET "phase" = 'COMPLETE';

-- CreateTable
CREATE TABLE "ProjectPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "status" "ProjectPlanStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectPlan_projectId_idx" ON "ProjectPlan"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectPlan" ADD CONSTRAINT "ProjectPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
