-- Two nullable ADD COLUMN and one index. Non-destructive: nothing is dropped, rewritten or
-- backfilled, and NULL — what every existing row gets — means exactly what the read path
-- already has to handle, "nobody ever checked this".
--
-- The repair loop runs *because* validation failed, and every pass it spends is written
-- straight into `Project.lastCode`. So the workspace preview, which compiles that file map in
-- the browser, shows the broken attempt for as long as the loop runs — on an edit to a
-- working site, that is worse than what the person had before they typed anything. These two
-- columns are the evidence that lets the read path decline to show it.
--
-- `Project.lastCodeValidated` is written in the same guarded UPDATE as `lastCode` (see
-- `writeMergedSite`), so it can never describe an older site than the one stored.
-- `Checkpoint.snapshotValidated` is the same fact about one frozen snapshot, which is what
-- makes an earlier version findable as a *proven* good one.
--
-- Three states, not two, and deliberately so. TRUE passed, FALSE failed, NULL was never
-- asked: a URL import, a checkpoint restore, and every row written before today. NULL is not
-- a quiet TRUE — a site nothing checked is not evidence of anything, so it neither triggers
-- the hold-back nor is offered as the version to hold back to. That keeps every existing
-- project on exactly its current behaviour until its next generation says otherwise.
ALTER TABLE "Project" ADD COLUMN "lastCodeValidated" BOOLEAN;
ALTER TABLE "Checkpoint" ADD COLUMN "snapshotValidated" BOOLEAN;

-- The held-back read asks one question — this project's newest snapshot proven good — and it
-- asks it on a file read, so it must not walk the whole history to answer.
CREATE INDEX "Checkpoint_projectId_snapshotValidated_createdAt_idx" ON "Checkpoint"("projectId", "snapshotValidated", "createdAt");
