import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import type { LockHolder, LockReason } from './lock';

export type PresenceViewer = {
  id: string;
  name: string;
  avatarUrl: string | null;
  lastSeenAt: Date;
};

export type ProjectLockState = {
  locked: boolean;
  heldBy: LockHolder | null;
  expiresAt: Date | null;
  reason: LockReason | null;
};

export type PresenceSnapshot = {
  viewers: PresenceViewer[];
  lock: ProjectLockState;
  contentVersion: number;
};

type PresenceRow = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  lastSeenAt: Date;
};

type LockStateRow = {
  lockedById: string | null;
  lockExpiresAt: Date | null;
  lockReason: string | null;
  contentVersion: number;
  holderName: string | null;
};

export async function heartbeatPresence(projectId: string, userId: string): Promise<void> {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "ProjectPresence" (id, "projectId", "userId", "lastSeenAt")
    VALUES (${id}, ${projectId}, ${userId}, NOW())
    ON CONFLICT ("projectId", "userId")
    DO UPDATE SET "lastSeenAt" = NOW()
  `;
}

export async function listRecentPresence(projectId: string): Promise<PresenceViewer[]> {
  const rows = await prisma.$queryRaw<PresenceRow[]>`
    SELECT
      p."userId",
      u.name,
      u."avatarUrl",
      p."lastSeenAt"
    FROM "ProjectPresence" p
    INNER JOIN "User" u ON u.id = p."userId"
    WHERE p."projectId" = ${projectId}
      AND p."lastSeenAt" > NOW() - INTERVAL '90 seconds'
    ORDER BY p."lastSeenAt" DESC
  `;
  return rows.map((row) => ({
    id: row.userId,
    name: row.name,
    avatarUrl: row.avatarUrl,
    lastSeenAt: row.lastSeenAt,
  }));
}

export async function getProjectLockState(projectId: string): Promise<{
  lock: ProjectLockState;
  contentVersion: number;
}> {
  const rows = await prisma.$queryRaw<LockStateRow[]>`
    SELECT
      p."lockedById",
      p."lockExpiresAt",
      p."lockReason",
      p."contentVersion",
      u.name AS "holderName"
    FROM "Project" p
    LEFT JOIN "User" u ON u.id = p."lockedById"
    WHERE p.id = ${projectId}
  `;
  const row = rows[0];
  if (!row) {
    return {
      lock: { locked: false, heldBy: null, expiresAt: null, reason: null },
      contentVersion: 0,
    };
  }
  const active =
    Boolean(row.lockedById) &&
    Boolean(row.lockExpiresAt) &&
    row.lockExpiresAt!.getTime() >= Date.now();
  return {
    contentVersion: Number(row.contentVersion) || 0,
    lock: active
      ? {
          locked: true,
          heldBy: { id: row.lockedById!, name: row.holderName || 'Someone' },
          expiresAt: row.lockExpiresAt,
          reason: (row.lockReason as LockReason | null) ?? null,
        }
      : { locked: false, heldBy: null, expiresAt: null, reason: null },
  };
}

export async function getPresenceSnapshot(projectId: string): Promise<PresenceSnapshot> {
  const [viewers, state] = await Promise.all([
    listRecentPresence(projectId),
    getProjectLockState(projectId),
  ]);
  return { viewers, lock: state.lock, contentVersion: state.contentVersion };
}

export async function pruneStalePresence(): Promise<{ pruned: number }> {
  const pruned = await prisma.$executeRaw`
    DELETE FROM "ProjectPresence"
    WHERE "lastSeenAt" < NOW() - INTERVAL '1 day'
  `;
  return { pruned };
}
