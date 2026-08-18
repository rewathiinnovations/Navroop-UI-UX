-- navroop:reviewed-destructive
-- Drops the sandbox subsystem's storage. Nothing has written these columns
-- since sandboxes were removed: previews are compiled in the browser and
-- published builds are bundled in-process, so there is no VM to track, meter,
-- or route. Deploy still requires ALLOW_DESTRUCTIVE_MIGRATION=true and a backup.

-- Job no longer points at a provider row.
ALTER TABLE "GenerationJob" DROP CONSTRAINT IF EXISTS "GenerationJob_providerConfigId_fkey";
ALTER TABLE "GenerationJob" DROP COLUMN IF EXISTS "providerConfigId";

-- Project no longer owns a VM.
DROP INDEX IF EXISTS "Project_sandboxStatus_sandboxLastUsedAt_idx";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_sandboxProviderConfigId_fkey";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxProviderConfigId";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxId";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxStatus";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxStartedAt";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxLastUsedAt";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "sandboxMeteredUntil";

-- Nothing consumes sandbox minutes.
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "sandboxMinutesUsed";
ALTER TABLE "Plan" DROP COLUMN IF EXISTS "maxConcurrentSandboxes";
ALTER TABLE "Plan" DROP COLUMN IF EXISTS "monthlySandboxMinutes";

DROP TABLE IF EXISTS "SandboxProviderConfig";
DROP TYPE IF EXISTS "SandboxStatus";

-- Every preview is STATIC now.
UPDATE "Project" SET "previewMode" = 'STATIC' WHERE "previewMode" <> 'STATIC';
UPDATE "PreviewBuild" SET "mode" = 'STATIC' WHERE "mode" <> 'STATIC';
ALTER TYPE "PreviewMode" RENAME TO "PreviewMode_old";
CREATE TYPE "PreviewMode" AS ENUM ('STATIC');
ALTER TABLE "Project" ALTER COLUMN "previewMode" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "previewMode" TYPE "PreviewMode" USING ("previewMode"::text::"PreviewMode");
ALTER TABLE "Project" ALTER COLUMN "previewMode" SET DEFAULT 'STATIC';
ALTER TABLE "PreviewBuild" ALTER COLUMN "mode" TYPE "PreviewMode" USING ("mode"::text::"PreviewMode");
DROP TYPE "PreviewMode_old";
