import type { PrismaClient } from '@/generated/prisma';
import { uniqueSuffix } from './ids';

/**
 * Typed against the generated Prisma delegates on purpose. While the `data`
 * argument was `Record<string, unknown>` this factory kept writing
 * `maxConcurrentSandboxes` / `monthlySandboxMinutes` after
 * `20260819010000_drop_sandbox_columns` removed those columns: nothing failed
 * until `ensureDefaultPlan` ran against a *fresh* test database, where four
 * suites died at bootstrap with `PrismaClientValidationError: Unknown argument`
 * before a single assertion ran. An already-seeded database hid it, because
 * `ensureDefaultPlan` short-circuits on the existing default plan.
 */
export type PlanFactoryDb = { plan: Pick<PrismaClient['plan'], 'create'> };

const MB = 1024 * 1024;

export type DefaultPlanRow = {
  id: string;
  key: string;
  monthlyCredits: number;
  maxProjects: number;
  maxPreviewSites: number;
  storageBytesLimit: bigint;
};

export type PlanEnsureDb = { plan: Pick<PrismaClient['plan'], 'findFirst' | 'upsert'> };

/** Idempotent Free/default plan — same keys as prisma/seed.ts. */
export async function ensureDefaultPlan(db: PlanEnsureDb): Promise<DefaultPlanRow> {
  const existing = await db.plan.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  return db.plan.upsert({
    where: { key: 'free' },
    create: {
      key: 'free',
      name: 'Free',
      isActive: true,
      isDefault: true,
      monthlyCredits: 100,
      maxProjects: 5,
      maxLiveSites: 1,
      maxPreviewSites: 3,
      maxMembers: 2,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(500 * MB),
      allowCustomDomain: false,
      allowGithubSync: false,
    },
    update: { isDefault: true, isActive: true },
  });
}

export async function createPlan(
  db: PlanFactoryDb,
  overrides: Partial<Parameters<PrismaClient['plan']['create']>[0]['data']> = {},
) {
  const suffix = uniqueSuffix();
  return db.plan.create({
    data: {
      key: `plan-${suffix}`,
      name: 'Test plan',
      isActive: true,
      isDefault: false,
      monthlyCredits: 100,
      maxProjects: 5,
      maxLiveSites: 1,
      maxPreviewSites: 3,
      maxMembers: 5,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(1024 * 1024 * 1024),
      allowCustomDomain: false,
      allowGithubSync: false,
      maxTokensPerJob: 120000,
      maxFilesPerJob: 60,
      maxOutputBytesPerJob: 2000000,
      ...overrides,
    },
  });
}
