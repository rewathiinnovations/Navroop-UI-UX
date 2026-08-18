import { WORKSPACE_ROW_ID } from '../../lib/storage/usage';

export type WorkspaceFactoryDb = {
  workspace: {
    upsert: (args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
};

export async function createWorkspace(
  db: WorkspaceFactoryDb,
  overrides: { id?: string; planId?: string; creditsUsed?: number } = {},
) {
  const id = overrides.id ?? WORKSPACE_ROW_ID;
  return db.workspace.upsert({
    where: { id },
    create: { id, storageBytes: 0, planId: overrides.planId, creditsUsed: overrides.creditsUsed ?? 0 },
    update: { planId: overrides.planId, creditsUsed: overrides.creditsUsed },
  });
}
