-- navroop:reviewed-destructive
-- Rebuilds the Stack enum, which rewrites Project.stack and Template.stack.
-- Rows on a removed stack are remapped first (below), so no data is lost.
-- Deploy still requires ALLOW_DESTRUCTIVE_MIGRATION=true and a backup.

-- Only NEXTJS, REACT and STATIC_HTML remain. Existing rows on a removed stack
-- move to the closest survivor rather than being dropped: Astro is
-- server-rendered like Next.js, Vue and Svelte are Vite SPAs like React.
UPDATE "Project" SET "stack" = 'NEXTJS' WHERE "stack" = 'ASTRO';
UPDATE "Project" SET "stack" = 'REACT' WHERE "stack" IN ('VUE', 'SVELTE');
UPDATE "Template" SET "stack" = 'NEXTJS' WHERE "stack" = 'ASTRO';
UPDATE "Template" SET "stack" = 'REACT' WHERE "stack" IN ('VUE', 'SVELTE');

-- Postgres cannot drop enum values, so the type is rebuilt. Every column that
-- uses it has to be converted before the old type can go.
ALTER TYPE "Stack" RENAME TO "Stack_old";
CREATE TYPE "Stack" AS ENUM ('NEXTJS', 'REACT', 'STATIC_HTML');

ALTER TABLE "Project" ALTER COLUMN "stack" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "stack" TYPE "Stack" USING ("stack"::text::"Stack");
ALTER TABLE "Project" ALTER COLUMN "stack" SET DEFAULT 'NEXTJS';

ALTER TABLE "Template" ALTER COLUMN "stack" DROP DEFAULT;
ALTER TABLE "Template" ALTER COLUMN "stack" TYPE "Stack" USING ("stack"::text::"Stack");
ALTER TABLE "Template" ALTER COLUMN "stack" SET DEFAULT 'NEXTJS';

DROP TYPE "Stack_old";
