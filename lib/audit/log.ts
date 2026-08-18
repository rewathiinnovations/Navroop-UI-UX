import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { logError } from '@/lib/logger';
import { getRequestContext } from '@/lib/request-context';
import { scrubSensitive } from '@/lib/sentry/scrub';

export const REQUIRED_AUDIT_ACTIONS = [
  'project.create',
  'project.soft_delete',
  'project.restore',
  'project.hard_purge',
  'member.invite',
  'member.role_change',
  'member.deactivate',
  'member.remove',
  'plan.assign',
  'plan.limits_edit',
  'integration.connect',
  'integration.disconnect',
  'deployment.create',
  'deployment.stop',
  'deployment.delete',
  'domain.add',
  'domain.remove',
  'api_key.add',
  'api_key.rotate',
  'api_key.delete',
  'workspace.generation_paused',
  'lock.force_release',
  'job.force_abandon',
  'password_reset.requested',
  'password_reset.completed',
  'template.create',
  'template.delete',
] as const;

export type AuditAction = (typeof REQUIRED_AUDIT_ACTIONS)[number] | string;

export type WriteAuditInput = {
  actorId?: string | null;
  actorEmail: string;
  action: AuditAction;
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type AuditPersist = (row: {
  id: string;
  workspaceId: string | null;
  actorId: string | null;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}) => Promise<void>;

function newId() {
  return `aud_${randomBytes(12).toString('hex')}`;
}

export async function persistAuditRow(row: Parameters<AuditPersist>[0]) {
  await prisma.$executeRaw`
    INSERT INTO "AuditLog" (
      id, "workspaceId", "actorId", "actorEmail", action, "targetType", "targetId",
      before, after, "requestId", ip, "userAgent", "createdAt"
    ) VALUES (
      ${row.id}, ${row.workspaceId}, ${row.actorId}, ${row.actorEmail}, ${row.action},
      ${row.targetType}, ${row.targetId},
      ${row.before == null ? null : JSON.stringify(row.before)}::jsonb,
      ${row.after == null ? null : JSON.stringify(row.after)}::jsonb,
      ${row.requestId}, ${row.ip}, ${row.userAgent}, NOW()
    )
  `;
}

export async function writeAudit(
  input: WriteAuditInput,
  deps?: { persist?: AuditPersist },
): Promise<void> {
  const persist = deps?.persist ?? persistAuditRow;
  const ctx = getRequestContext();
  try {
    await persist({
      id: newId(),
      workspaceId: input.workspaceId ?? ctx?.workspaceId ?? null,
      actorId: input.actorId ?? ctx?.userId ?? null,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      before: scrubSensitive(input.before ?? null),
      after: scrubSensitive(input.after ?? null),
      requestId: input.requestId ?? ctx?.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (error) {
    logError('audit.write_failed', error, { action: input.action });
  }
}

export async function pruneAuditLogs(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const deleted = await prisma.$executeRaw`
    DELETE FROM "AuditLog" WHERE "createdAt" < ${cutoff}
  `;
  return { deleted: Number(deleted) };
}

export function formatAuditDiff(before: unknown, after: unknown) {
  const prev = before && typeof before === 'object' ? (before as Record<string, unknown>) : {};
  const next = after && typeof after === 'object' ? (after as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const lines: string[] = [];
  for (const key of keys) {
    if (prev[key] === next[key]) continue;
    lines.push(`${key}: ${stringifyAuditValue(prev[key])} → ${stringifyAuditValue(next[key])}`);
  }
  return lines;
}

function stringifyAuditValue(value: unknown) {
  if (value == null) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
