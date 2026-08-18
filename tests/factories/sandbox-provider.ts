import { uniqueSuffix } from './ids';

export type SandboxProviderFactoryDb = {
  sandboxProviderConfig: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; driver: string }>;
  };
};

export async function createSandboxProviderConfig(
  db: SandboxProviderFactoryDb,
  overrides: { driver?: string; creditType?: string; creditRemainingUsd?: number; isActive?: boolean } = {},
) {
  return db.sandboxProviderConfig.create({
    data: {
      name: `Provider ${uniqueSuffix()}`,
      driver: overrides.driver ?? 'e2b',
      isActive: overrides.isActive ?? true,
      secrets: 'encrypted',
      config: {},
      creditType: overrides.creditType ?? 'free',
      creditRemainingUsd: overrides.creditRemainingUsd ?? 10,
    },
  });
}
