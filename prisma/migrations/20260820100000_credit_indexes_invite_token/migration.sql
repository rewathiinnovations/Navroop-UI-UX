-- Hot-list composite indexes, CreditLedger.projectId index, pending-invite columns.
-- Non-destructive: three CREATE INDEX and three nullable ADD COLUMN. Nothing is dropped,
-- rewritten or backfilled, and every existing row stays valid.

-- F-314: listProjects filters `deletedAt IS NULL` and orders by `updatedAt DESC`. Project
-- indexed [ownerId], [deletedAt], [lockedById, lockExpiresAt] and the search vector, so
-- Postgres filtered and then sorted the whole matching set on every dashboard visit.
CREATE INDEX "Project_deletedAt_updatedAt_idx" ON "Project"("deletedAt", "updatedAt");

-- F-314: the export route reads `checkpoints where snapshotPruned = false order by
-- createdAt desc` for one project. No existing index leads with projectId plus createdAt,
-- so per-project history was filtered and sorted rather than read in order.
CREATE INDEX "Checkpoint_projectId_createdAt_idx" ON "Checkpoint"("projectId", "createdAt");

-- F-363: CreditLedger.projectId is deliberately an unconstrained pointer — billing history
-- survives project deletion — but per-project attribution was a sequential scan. The index
-- makes it usable. No foreign key: adding one would cascade or restrict project deletion
-- and that is a separate design decision, not an index.
CREATE INDEX "CreditLedger_projectId_idx" ON "CreditLedger"("projectId");

-- F-351: an Invite row can now express a pending invitation — a single-use hashed token,
-- an expiry and a revocation — the way PasswordResetToken already does. The acceptance
-- flow that consumes these columns does not exist yet: POST /api/admin/invite still creates
-- the User outright and writes the invite already accepted. These columns are the schema
-- half only, and stay NULL until that flow is built.
ALTER TABLE "Invite" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "Invite" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Invite" ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
