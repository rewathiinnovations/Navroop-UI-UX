-- Checkpoint snapshots move to object storage. fileSnapshot stays for legacy reads.
ALTER TABLE "Checkpoint" ALTER COLUMN "fileSnapshot" DROP NOT NULL;
ALTER TABLE "Checkpoint" ADD COLUMN "snapshotKey" TEXT;
ALTER TABLE "Checkpoint" ADD COLUMN "snapshotBytes" INTEGER;
ALTER TABLE "Checkpoint" ADD COLUMN "snapshotFileCount" INTEGER;
ALTER TABLE "Checkpoint" ADD COLUMN "isBookmarked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Checkpoint" ADD COLUMN "snapshotPruned" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Checkpoint_createdAt_idx" ON "Checkpoint"("createdAt");
CREATE INDEX "Checkpoint_isBookmarked_snapshotPruned_createdAt_idx" ON "Checkpoint"("isBookmarked", "snapshotPruned", "createdAt");

-- Single-row workspace storage ledger (id = 'default').
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "storageBytes" INTEGER NOT NULL DEFAULT 0,
    "storageLimitBytes" INTEGER,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Workspace" ("id", "storageBytes") VALUES ('default', 0);
