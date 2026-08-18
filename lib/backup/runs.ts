import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';

export type BackupKind = 'db' | 'storage_verify' | 'restore_test';
export type BackupStatus = 'running' | 'success' | 'failed';

export type BackupRunRow = {
  id: string;
  kind: BackupKind;
  status: string;
  objectKey: string | null;
  sizeBytes: string | null;
  durationMs: number | null;
  detail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

function newId() {
  return `bck_${randomBytes(12).toString('hex')}`;
}

function asDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date();
}

function mapRow(row: Record<string, unknown>): BackupRunRow {
  const size = row.sizeBytes;
  return {
    id: String(row.id),
    kind: String(row.kind) as BackupKind,
    status: String(row.status),
    objectKey: row.objectKey == null ? null : String(row.objectKey),
    sizeBytes: size == null ? null : String(size),
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    detail: row.detail == null ? null : String(row.detail),
    startedAt: asDate(row.startedAt),
    finishedAt: row.finishedAt == null ? null : asDate(row.finishedAt),
  };
}

export async function startBackupRun(kind: BackupKind): Promise<BackupRunRow> {
  const id = newId();
  const startedAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO "BackupRun" ("id", "kind", "status", "startedAt")
    VALUES (${id}, ${kind}, ${'running'}, ${startedAt})
  `;
  return {
    id,
    kind,
    status: 'running',
    objectKey: null,
    sizeBytes: null,
    durationMs: null,
    detail: null,
    startedAt,
    finishedAt: null,
  };
}

export async function finishBackupRun(input: {
  id: string;
  status: BackupStatus;
  objectKey?: string | null;
  sizeBytes?: number | bigint | null;
  detail?: string | null;
  startedAt: Date;
}) {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - input.startedAt.getTime());
  const size = input.sizeBytes == null ? null : BigInt(input.sizeBytes);
  await prisma.$executeRaw`
    UPDATE "BackupRun"
    SET
      "status" = ${input.status},
      "objectKey" = ${input.objectKey ?? null},
      "sizeBytes" = ${size},
      "durationMs" = ${durationMs},
      "detail" = ${input.detail ?? null},
      "finishedAt" = ${finishedAt}
    WHERE "id" = ${input.id}
  `;
  return { ...input, durationMs, finishedAt };
}

export async function listBackupRuns(limit = 50): Promise<BackupRunRow[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, kind, status, "objectKey", "sizeBytes", "durationMs", detail, "startedAt", "finishedAt"
    FROM "BackupRun"
    ORDER BY "startedAt" DESC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

export async function latestSuccessfulDbBackup(): Promise<BackupRunRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, kind, status, "objectKey", "sizeBytes", "durationMs", detail, "startedAt", "finishedAt"
    FROM "BackupRun"
    WHERE kind = ${'db'} AND status = ${'success'}
    ORDER BY "startedAt" DESC
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function latestRestoreTest(): Promise<BackupRunRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, kind, status, "objectKey", "sizeBytes", "durationMs", detail, "startedAt", "finishedAt"
    FROM "BackupRun"
    WHERE kind = ${'restore_test'} AND status = ${'success'}
    ORDER BY "startedAt" DESC
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function latestRunningDbBackup(): Promise<BackupRunRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, kind, status, "objectKey", "sizeBytes", "durationMs", detail, "startedAt", "finishedAt"
    FROM "BackupRun"
    WHERE kind = ${'db'} AND status = ${'running'}
    ORDER BY "startedAt" DESC
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}
