import { uniqueSuffix } from './ids';

export type PlanFactoryDb = {
  plan: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; key: string }>;
  };
};

const MB = 1024 * 1024;

export type DefaultPlanRow = {
  id: string;
  key: string;
  monthlyCredits: number;
  maxProjects: number;
  maxPreviewSites: number;
  storageBytesLimit: bigint;
};

export type PlanEnsureDb = {
  plan: {
    findFirst: (args: { where: { isDefault: boolean } }) => Promise<DefaultPlanRow | null>;
    upsert: (args: {
      where: { key: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<DefaultPlanRow>;
  };
};

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
      maxConcurrentSandboxes: 1,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(500 * MB),
      allowCustomDomain: false,
      allowGithubSync: false,
    },
    update: { isDefault: true, isActive: true },
  });
}

export async function createPlan(db: PlanFactoryDb, overrides: Record<string, unknown> = {}) {
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
      maxConcurrentSandboxes: 2,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(1024 * 1024 * 1024),
      allowCustomDomain: false,
      allowGithubSync: false,
      maxTokensPerJob: 120000,
      maxFilesPerJob: 60,
      maxOutputBytesPerJob: 2000000,
      monthlySandboxMinutes: 300,
      ...overrides,
    },
  });
}
