import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  DEFAULT_ROUTING_STRATEGY,
  STRATEGY_SETTING_KEY,
  isSandboxDriver,
  type CreditType,
  type DriverSecrets,
  type RoutingStrategy,
  type SandboxDriverId,
} from './provider';

export type StoredProviderConfig = {
  id: string;
  name: string;
  driver: SandboxDriverId;
  isActive: boolean;
  priority: number;
  weight: number;
  secrets: string;
  config: Record<string, unknown>;
  creditType: CreditType;
  creditTotalUsd: number | null;
  creditRemainingUsd: number | null;
  creditResetsAt: Date | null;
  monthlyBudgetUsd: number | null;
  monthlyMinutesLimit: number | null;
  minutesUsed: number;
  spendUsd: number;
  periodStart: Date;
  healthStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  consecutiveFails: number;
  createdAt: Date;
  updatedAt: Date;
};

type ProviderSqlRow = {
  id: string;
  name: string;
  driver: string;
  isActive: boolean;
  priority: number;
  weight: number;
  secrets: string;
  config: unknown;
  creditType: string;
  creditTotalUsd: unknown;
  creditRemainingUsd: unknown;
  creditResetsAt: Date | null;
  monthlyBudgetUsd: unknown;
  monthlyMinutesLimit: number | null;
  minutesUsed: number;
  spendUsd: unknown;
  periodStart: Date;
  healthStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  consecutiveFails: number;
  createdAt: Date;
  updatedAt: Date;
};

function num(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapRow(row: ProviderSqlRow): StoredProviderConfig {
  const driver = isSandboxDriver(row.driver) ? row.driver : 'e2b';
  const config =
    row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    name: row.name,
    driver,
    isActive: row.isActive,
    priority: row.priority,
    weight: row.weight,
    secrets: row.secrets,
    config,
    creditType: row.creditType as CreditType,
    creditTotalUsd: num(row.creditTotalUsd),
    creditRemainingUsd: num(row.creditRemainingUsd),
    creditResetsAt: row.creditResetsAt,
    monthlyBudgetUsd: num(row.monthlyBudgetUsd),
    monthlyMinutesLimit: row.monthlyMinutesLimit,
    minutesUsed: row.minutesUsed ?? 0,
    spendUsd: num(row.spendUsd) ?? 0,
    periodStart: row.periodStart,
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    consecutiveFails: row.consecutiveFails ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Plain text, spliced in — see the note on JOB_COLUMNS in lib/jobs/store.ts. */
const COLUMNS = `
  id, name, driver, "isActive", priority, weight, secrets, config,
  "creditType", "creditTotalUsd", "creditRemainingUsd", "creditResetsAt",
  "monthlyBudgetUsd", "monthlyMinutesLimit", "minutesUsed", "spendUsd",
  "periodStart", "healthStatus", "lastCheckedAt", "lastError", "consecutiveFails",
  "createdAt", "updatedAt"
`;

export async function listProviderConfigs() {
  const rows = await prisma.$queryRawUnsafe<ProviderSqlRow[]>(
    `SELECT ${COLUMNS} FROM "SandboxProviderConfig" ORDER BY priority ASC, "createdAt" ASC`,
  );
  return rows.map(mapRow);
}

export async function getProviderConfig(id: string) {
  const rows = await prisma.$queryRawUnsafe<ProviderSqlRow[]>(
    `SELECT ${COLUMNS} FROM "SandboxProviderConfig" WHERE id = $1 LIMIT 1`,
    id,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function countActiveProviders() {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "SandboxProviderConfig" WHERE "isActive" = true
  `;
  return Number(rows[0]?.count ?? 0);
}

export function encryptProviderSecrets(secrets: DriverSecrets) {
  return encrypt(JSON.stringify(secrets));
}

export function decryptProviderSecrets(blob: string): DriverSecrets {
  try {
    const parsed = JSON.parse(decrypt(blob)) as DriverSecrets;
    return parsed && typeof parsed === 'object' ? parsed : { apiKey: '' };
  } catch {
    return { apiKey: '' };
  }
}

export function maskSecrets(driver: SandboxDriverId, secrets: DriverSecrets) {
  if (driver === 'modal') {
    const modal = secrets as { tokenId?: string; tokenSecret?: string };
    return {
      tokenId: modal.tokenId ? `••••${modal.tokenId.slice(-4)}` : '',
      tokenSecret: modal.tokenSecret ? '••••••••' : '',
    };
  }
  const key = (secrets as { apiKey?: string }).apiKey;
  return { apiKey: key ? `••••${key.slice(-4)}` : '' };
}

export async function getRoutingStrategy(): Promise<RoutingStrategy> {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT value FROM "AppSetting" WHERE key = ${STRATEGY_SETTING_KEY} LIMIT 1
  `;
  const value = rows[0]?.value;
  if (value === 'priority' || value === 'round_robin' || value === 'cheapest' || value === 'free_first') {
    return value;
  }
  return DEFAULT_ROUTING_STRATEGY;
}

export async function setRoutingStrategy(strategy: RoutingStrategy) {
  await prisma.$executeRaw`
    INSERT INTO "AppSetting" (key, value, "updatedAt")
    VALUES (${STRATEGY_SETTING_KEY}, ${strategy}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${strategy}, "updatedAt" = NOW()
  `;
}

export async function insertProviderConfig(input: {
  id: string;
  name: string;
  driver: SandboxDriverId;
  secrets: string;
  config?: Record<string, unknown>;
  creditType: CreditType;
  creditTotalUsd?: number | null;
  creditRemainingUsd?: number | null;
  creditResetsAt?: Date | null;
  priority?: number;
  weight?: number;
  isActive?: boolean;
}) {
  const config = JSON.stringify(input.config ?? {});
  await prisma.$executeRaw`
    INSERT INTO "SandboxProviderConfig" (
      id, name, driver, "isActive", priority, weight, secrets, config,
      "creditType", "creditTotalUsd", "creditRemainingUsd", "creditResetsAt",
      "spendUsd", "minutesUsed", "periodStart", "healthStatus", "consecutiveFails",
      "createdAt", "updatedAt"
    ) VALUES (
      ${input.id}, ${input.name}, ${input.driver}, ${input.isActive ?? true},
      ${input.priority ?? 100}, ${input.weight ?? 1}, ${input.secrets}, ${config}::jsonb,
      ${input.creditType}, ${input.creditTotalUsd ?? null}, ${input.creditRemainingUsd ?? null},
      ${input.creditResetsAt ?? null}, 0, 0, NOW(), 'unknown', 0, NOW(), NOW()
    )
  `;
  return getProviderConfig(input.id);
}

export async function updateProviderConfig(
  id: string,
  fields: Partial<{
    name: string;
    isActive: boolean;
    priority: number;
    weight: number;
    secrets: string;
    config: Record<string, unknown>;
    creditType: CreditType;
    creditTotalUsd: number | null;
    creditRemainingUsd: number | null;
    creditResetsAt: Date | null;
    monthlyBudgetUsd: number | null;
    monthlyMinutesLimit: number | null;
    minutesUsed: number;
    spendUsd: number;
    periodStart: Date;
    healthStatus: string;
    lastCheckedAt: Date | null;
    lastError: string | null;
    consecutiveFails: number;
  }>,
) {
  const sets: string[] = ['"updatedAt" = NOW()'];
  const values: unknown[] = [];
  const set = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (fields.name !== undefined) set('name', fields.name);
  if (fields.isActive !== undefined) set('"isActive"', fields.isActive);
  if (fields.priority !== undefined) set('priority', fields.priority);
  if (fields.weight !== undefined) set('weight', fields.weight);
  if (fields.secrets !== undefined) set('secrets', fields.secrets);
  if (fields.config !== undefined) set('config', JSON.stringify(fields.config), '::jsonb');
  if (fields.creditType !== undefined) set('"creditType"', fields.creditType);
  if (fields.creditTotalUsd !== undefined) set('"creditTotalUsd"', fields.creditTotalUsd);
  if (fields.creditRemainingUsd !== undefined) set('"creditRemainingUsd"', fields.creditRemainingUsd);
  if (fields.creditResetsAt !== undefined) set('"creditResetsAt"', fields.creditResetsAt);
  if (fields.monthlyBudgetUsd !== undefined) set('"monthlyBudgetUsd"', fields.monthlyBudgetUsd);
  if (fields.monthlyMinutesLimit !== undefined) set('"monthlyMinutesLimit"', fields.monthlyMinutesLimit);
  if (fields.minutesUsed !== undefined) set('"minutesUsed"', fields.minutesUsed);
  if (fields.spendUsd !== undefined) set('"spendUsd"', fields.spendUsd);
  if (fields.periodStart !== undefined) set('"periodStart"', fields.periodStart);
  if (fields.healthStatus !== undefined) set('"healthStatus"', fields.healthStatus);
  if (fields.lastCheckedAt !== undefined) set('"lastCheckedAt"', fields.lastCheckedAt);
  if (fields.lastError !== undefined) set('"lastError"', fields.lastError);
  if (fields.consecutiveFails !== undefined) set('"consecutiveFails"', fields.consecutiveFails);

  values.push(id);
  await prisma.$executeRawUnsafe(
    `UPDATE "SandboxProviderConfig" SET ${sets.join(', ')} WHERE id = $${values.length}`,
    ...values,
  );
  return getProviderConfig(id);
}

export async function deleteProviderConfig(id: string) {
  await prisma.$executeRaw`DELETE FROM "SandboxProviderConfig" WHERE id = ${id}`;
}
