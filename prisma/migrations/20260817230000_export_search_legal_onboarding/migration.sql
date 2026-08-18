-- User preference + legal acceptance (merge; do not drop passwordChangedAt).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "promptTipsDismissedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "productTourCompletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;

-- Full-text search over project name + original prompt. Prisma cannot express
-- a generated tsvector; keep this column out of the Prisma model.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "searchVector" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("initialPrompt", '')), 'B')
) STORED;

CREATE INDEX IF NOT EXISTS "Project_searchVector_idx" ON "Project" USING GIN ("searchVector");
