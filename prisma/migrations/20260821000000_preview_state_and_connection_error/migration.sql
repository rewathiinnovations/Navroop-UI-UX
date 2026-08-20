-- Three nullable ADD COLUMN. Non-destructive: nothing is dropped, rewritten or backfilled,
-- every existing row stays valid, and both features read NULL as their existing behaviour.

-- F-102: "Preview this version" wrote the old snapshot straight into `Project.lastCode` —
-- the row the product renders, publishes, exports and checkpoints from — and the only record
-- that the write was meant to be temporary was a `useState` in the workspace. One reload and
-- the project silently *was* the old version. A preview is now a read: this column names the
-- checkpoint the workspace is viewing, the files route serves that snapshot, and `lastCode`
-- is never touched. NULL means "on the current version", which is what every existing row is.
--
-- Not a foreign key on purpose. Checkpoint rows are never deleted except with their project
-- (thinning clears the snapshot and sets `snapshotPruned`, it does not remove the row), and
-- the read path already has to answer "that version is unreadable" distinctly from "there is
-- no preview" — so a dangling id is reported, not silently swallowed by a cascade.
ALTER TABLE "Project" ADD COLUMN "previewingCheckpointId" TEXT;

-- F-206: the Connectors push uses a per-user OAuth token, but a rejection was written to the
-- workspace-wide `GITHUB_DEPLOY` Integration row as `status = 'ERROR'`. Since the publish gate
-- counts only CONNECTED, one member letting their personal authorisation expire blocked
-- publishing for the whole workspace and told an admin to reconnect a GitHub App that was
-- never broken. The failure now lands on the row that actually failed.
--
-- `lastErrorAt` is compared against `connectedAt`: a reconnect bumps `connectedAt`, which
-- retires a stale note without needing a second write to remember to clear it.
ALTER TABLE "GitHubConnection" ADD COLUMN "lastError" TEXT;
ALTER TABLE "GitHubConnection" ADD COLUMN "lastErrorAt" TIMESTAMP(3);
