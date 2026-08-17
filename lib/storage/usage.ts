import { prisma } from '@/lib/db';

/** Single-row Workspace ledger. See prisma Workspace model. */
export const WORKSPACE_ROW_ID = 'default';

export async function getWorkspaceStorage() {
  return prisma.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: 0 },
    update: {},
  });
}

export async function adjustStorageBytes(delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return;
  await getWorkspaceStorage();
  await prisma.workspace.update({
    where: { id: WORKSPACE_ROW_ID },
    data: { storageBytes: { increment: Math.trunc(delta) } },
  });
  await prisma.workspace.updateMany({
    where: { id: WORKSPACE_ROW_ID, storageBytes: { lt: 0 } },
    data: { storageBytes: 0 },
  });
}

export { formatStorageBytes } from './format';
