-- F-202: record the immutable GitHub repository id the first time publish creates the
-- deploy repo, so a later publish can refuse to force-push over a same-named repository
-- this project did not create. Nullable: rows that predate the column adopt the id on
-- their next publish when they already pushed to that exact repo.
ALTER TABLE "Deployment" ADD COLUMN "githubRepoId" TEXT;
