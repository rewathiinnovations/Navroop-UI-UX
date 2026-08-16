-- AlterTable
ALTER TABLE "ProjectPlan" ADD COLUMN "sourceMessage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProjectPlan" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'initial';

-- Backfill existing rows from the project's initialPrompt
UPDATE "ProjectPlan" AS plan
SET
  "trigger" = 'initial',
  "sourceMessage" = project."initialPrompt"
FROM "Project" AS project
WHERE plan."projectId" = project.id;

ALTER TABLE "ProjectPlan" ALTER COLUMN "sourceMessage" DROP DEFAULT;
ALTER TABLE "ProjectPlan" ALTER COLUMN "trigger" DROP DEFAULT;
