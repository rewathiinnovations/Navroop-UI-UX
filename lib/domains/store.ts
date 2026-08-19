import { randomBytes } from 'node:crypto';
import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import type { CustomDomainPath, CustomDomainRow, CustomDomainStatus } from './types';

export class DuplicateHostnameError extends Error {
  constructor(hostname: string) {
    super(`This hostname is already in use: ${hostname}`);
    this.name = 'DuplicateHostnameError';
  }
}

function newId() {
  return `c${randomBytes(12).toString('hex')}`;
}

function asStringArray(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      return asStringArray(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

function mapRow(row: Record<string, unknown>): CustomDomainRow {
  return {
    id: String(row.id),
    deploymentId: String(row.deploymentId),
    workspaceId: String(row.workspaceId),
    hostname: String(row.hostname),
    status: row.status as CustomDomainStatus,
    verifyToken: String(row.verifyToken),
    expectedTarget: String(row.expectedTarget),
    lastCheckedAt:
      row.lastCheckedAt instanceof Date
        ? row.lastCheckedAt
        : row.lastCheckedAt
          ? new Date(String(row.lastCheckedAt))
          : null,
    lastError: row.lastError == null ? null : String(row.lastError),
    sslIssuedAt:
      row.sslIssuedAt instanceof Date
        ? row.sslIssuedAt
        : row.sslIssuedAt
          ? new Date(String(row.sslIssuedAt))
          : null,
    isPrimary: Boolean(row.isPrimary),
    path: (row.path as CustomDomainPath) || 'A',
    cloudflareZoneId: row.cloudflareZoneId == null ? null : String(row.cloudflareZoneId),
    nameservers: asStringArray(row.nameservers),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
  };
}

export async function insertCustomDomain(input: {
  deploymentId: string;
  workspaceId: string;
  hostname: string;
  verifyToken: string;
  expectedTarget: string;
  path: CustomDomainPath;
  cloudflareZoneId?: string | null;
  nameservers?: string[] | null;
}): Promise<CustomDomainRow> {
  const id = newId();
  const nameservers = input.nameservers ?? null;
  try {
    await prisma.$executeRaw`
      INSERT INTO "CustomDomain" (
        "id", "deploymentId", "workspaceId", "hostname", "status", "verifyToken",
        "expectedTarget", "isPrimary", "path"
      ) VALUES (
        ${id}, ${input.deploymentId}, ${input.workspaceId}, ${input.hostname},
        CAST(${'PENDING_DNS'} AS "CustomDomainStatus"), ${input.verifyToken}, ${input.expectedTarget},
        false, CAST(${input.path} AS "CustomDomainPath")
      )
    `;
    if (input.cloudflareZoneId || nameservers) {
      await updateCustomDomain(id, {
        cloudflareZoneId: input.cloudflareZoneId ?? null,
        nameservers,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('CustomDomain_hostname_key') || message.includes('unique')) {
      throw new DuplicateHostnameError(input.hostname);
    }
    throw error;
  }
  const row = await findCustomDomain(id);
  if (!row) throw new Error('Custom domain insert failed');
  return row;
}

/** Unscoped — for cron and internal store round-trips only. Anything reached from a
 *  request must use `findCustomDomainForProject`. */
export async function findCustomDomain(id: string): Promise<CustomDomainRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "CustomDomain" WHERE "id" = ${id} LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Project-scoped lookup for every user-triggered domain mutation.
 *
 * `CustomDomain` carries no `projectId` of its own — it hangs off `Deployment` — so the
 * scoping predicate has to be the same join `listCustomDomainsForProject` uses. Callers
 * authorise the session against the project id from the URL, so a lookup by domain id
 * alone let any project owner delete, re-point, re-verify or email the DNS instructions
 * (verify token included) of a domain belonging to another member's project.
 */
export async function findCustomDomainForProject(
  projectId: string,
  id: string,
): Promise<CustomDomainRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT d.* FROM "CustomDomain" d
    INNER JOIN "Deployment" p ON p."id" = d."deploymentId"
    WHERE d."id" = ${id} AND p."projectId" = ${projectId}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findCustomDomainByHostname(
  hostname: string,
): Promise<CustomDomainRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "CustomDomain" WHERE "hostname" = ${hostname} LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listCustomDomainsForDeployment(
  deploymentId: string,
): Promise<CustomDomainRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "CustomDomain" WHERE "deploymentId" = ${deploymentId} ORDER BY "createdAt" ASC
  `;
  return rows.map(mapRow);
}

export async function listCustomDomainsForProject(projectId: string): Promise<CustomDomainRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT d.* FROM "CustomDomain" d
    INNER JOIN "Deployment" p ON p."id" = d."deploymentId"
    WHERE p."projectId" = ${projectId}
    ORDER BY d."createdAt" ASC
  `;
  return rows.map(mapRow);
}

export async function listCheckableCustomDomains(): Promise<CustomDomainRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "CustomDomain"
    WHERE "status" IN ('PENDING_DNS', 'VERIFYING', 'SSL_PENDING')
    ORDER BY "lastCheckedAt" ASC NULLS FIRST
  `;
  return rows.map(mapRow);
}

export async function updateCustomDomain(
  id: string,
  data: Partial<
    Pick<
      CustomDomainRow,
      | 'status'
      | 'lastCheckedAt'
      | 'lastError'
      | 'sslIssuedAt'
      | 'isPrimary'
      | 'cloudflareZoneId'
      | 'nameservers'
    >
  >,
): Promise<CustomDomainRow> {
  const current = await findCustomDomain(id);
  if (!current) throw new Error('Custom domain not found');
  const status = data.status ?? current.status;
  const lastError = data.lastError === undefined ? current.lastError : data.lastError;
  const lastCheckedAt =
    data.lastCheckedAt === undefined ? current.lastCheckedAt : data.lastCheckedAt;
  const sslIssuedAt = data.sslIssuedAt === undefined ? current.sslIssuedAt : data.sslIssuedAt;
  const isPrimary = data.isPrimary === undefined ? current.isPrimary : data.isPrimary;
  const cloudflareZoneId =
    data.cloudflareZoneId === undefined ? current.cloudflareZoneId : data.cloudflareZoneId;
  const nameservers = data.nameservers === undefined ? current.nameservers : data.nameservers;
  await prisma.$executeRaw`
    UPDATE "CustomDomain" SET
      "status" = CAST(${status} AS "CustomDomainStatus"),
      "lastError" = ${lastError},
      "lastCheckedAt" = ${lastCheckedAt},
      "sslIssuedAt" = ${sslIssuedAt},
      "isPrimary" = ${isPrimary},
      "cloudflareZoneId" = ${cloudflareZoneId}
    WHERE "id" = ${id}
  `;
  if (data.nameservers !== undefined) {
    if (nameservers?.length) {
      await prisma.$executeRaw`
        UPDATE "CustomDomain" SET "nameservers" = CAST(${JSON.stringify(nameservers)} AS JSONB) WHERE "id" = ${id}
      `;
    } else {
      await prisma.$executeRaw`UPDATE "CustomDomain" SET "nameservers" = NULL WHERE "id" = ${id}`;
    }
  }
  const row = await findCustomDomain(id);
  if (!row) throw new Error('Custom domain update failed');
  return row;
}

export async function clearPrimaryForDeployment(deploymentId: string, exceptId?: string) {
  if (exceptId) {
    await prisma.$executeRaw`
      UPDATE "CustomDomain" SET "isPrimary" = false
      WHERE "deploymentId" = ${deploymentId} AND "id" <> ${exceptId}
    `;
    return;
  }
  await prisma.$executeRaw`
    UPDATE "CustomDomain" SET "isPrimary" = false WHERE "deploymentId" = ${deploymentId}
  `;
}

export async function deleteCustomDomainRow(id: string) {
  await prisma.$executeRaw`DELETE FROM "CustomDomain" WHERE "id" = ${id}`;
}

export async function findPrimaryForDeployment(
  deploymentId: string,
): Promise<CustomDomainRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "CustomDomain"
    WHERE "deploymentId" = ${deploymentId} AND "isPrimary" = true AND "status" = 'ACTIVE'
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function mapPrimaryHosts(deploymentIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (deploymentIds.length === 0) return result;
  // One placeholder per id, numbered here — see the note on JOB_COLUMNS in
  // lib/jobs/store.ts for why Prisma.join is not interpolated into a tagged template.
  const placeholders = deploymentIds.map((_, index) => `$${index + 1}`).join(', ');
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "deploymentId", "hostname" FROM "CustomDomain"
    WHERE "isPrimary" = true AND "status" = 'ACTIVE'
      AND "deploymentId" IN (${placeholders})`,
    ...deploymentIds,
  );
  for (const row of rows) {
    result.set(String(row.deploymentId), String(row.hostname));
  }
  return result;
}
