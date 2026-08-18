-- Audit log, last-admin trigger, deployment RESTRICT, preview-slug DNS uniqueness.
-- Does not drop Plan/Workspace consumption columns. one_active_job_per_project already exists.

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- Last admin: serialize demotions and refuse when the update would leave zero active admins.
CREATE OR REPLACE FUNCTION prevent_last_admin_removal()
RETURNS trigger AS $$
DECLARE
  remaining integer;
BEGIN
  IF NOT (
    OLD.role = 'ADMIN' AND OLD."isActive" = true
    AND (NEW.role IS DISTINCT FROM 'ADMIN' OR NEW."isActive" IS DISTINCT FROM true)
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(872314001);

  SELECT COUNT(*) INTO remaining
  FROM "User"
  WHERE role = 'ADMIN'
    AND "isActive" = true
    AND id IS DISTINCT FROM NEW.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last admin'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_prevent_last_admin ON "User";
CREATE TRIGGER user_prevent_last_admin
  BEFORE UPDATE ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_last_admin_removal();

-- Hard-delete of a project with a deployment must go through purge (external resources first).
ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_projectId_fkey";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- LIVE slug `preview-acme` must not collide with PREVIEW slug `acme` (DNS label preview-acme).
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_dns_label_key"
  ON "Deployment" ((CASE WHEN kind = 'PREVIEW' THEN 'preview-' || slug ELSE slug END));
