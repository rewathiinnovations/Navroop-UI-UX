-- Index every foreign key that had none.
--
-- Postgres creates an index for a PRIMARY KEY and for UNIQUE, but never for a
-- REFERENCES column. Without one, enforcing the constraint on the parent side
-- means a sequential scan of the child table for every delete, and any query
-- filtering by that key scans too.
--
-- The two that matter most:
--
--   GenerationJob.workspaceId / userId are both ON DELETE CASCADE on the
--   fastest-growing table in the schema — one row per generation. Deleting a
--   workspace or a user scanned all of it.
--
--   Template.workspaceId carries the list query the /templates page runs on
--   every load ("built-in plus this workspace"); the only index on Template was
--   [category, isActive], which that predicate cannot use.
--
-- Deployment.serverId and publishedById are ON DELETE RESTRICT, so removing a
-- CoolifyServer or a User scanned Deployment to look for referencing rows.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs each migration in a
-- transaction and CONCURRENTLY cannot run inside one. These tables are small
-- enough for the brief write lock; revisit if GenerationJob ever gets large.

-- CreateIndex
CREATE INDEX "Project_activeJobId_idx" ON "Project"("activeJobId");

-- CreateIndex
CREATE INDEX "Workspace_planId_idx" ON "Workspace"("planId");

-- CreateIndex
CREATE INDEX "Invite_invitedById_idx" ON "Invite"("invitedById");

-- CreateIndex
CREATE INDEX "Skill_createdById_idx" ON "Skill"("createdById");

-- CreateIndex
CREATE INDEX "Integration_connectedById_idx" ON "Integration"("connectedById");

-- CreateIndex
CREATE INDEX "Deployment_serverId_idx" ON "Deployment"("serverId");

-- CreateIndex
CREATE INDEX "Deployment_publishedById_idx" ON "Deployment"("publishedById");

-- CreateIndex
CREATE INDEX "Template_workspaceId_idx" ON "Template"("workspaceId");

-- CreateIndex
CREATE INDEX "Template_createdById_idx" ON "Template"("createdById");

-- CreateIndex
CREATE INDEX "GenerationJob_workspaceId_idx" ON "GenerationJob"("workspaceId");

-- CreateIndex
CREATE INDEX "GenerationJob_userId_idx" ON "GenerationJob"("userId");
