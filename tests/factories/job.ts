import { WORKSPACE_ROW_ID } from '../../lib/storage/usage';
import { uniqueSuffix } from './ids';

export type JobFactoryDb = {
  job: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; status: string }>;
  };
};

export async function createJob(
  db: JobFactoryDb,
  overrides: {
    projectId: string;
    userId: string;
    workspaceId?: string;
    kind?: string;
    status?: string;
    idempotencyKey?: string;
    creditsChargedAt?: Date | null;
  },
) {
  return db.job.create({
    data: {
      projectId: overrides.projectId,
      userId: overrides.userId,
      workspaceId: overrides.workspaceId ?? WORKSPACE_ROW_ID,
      kind: overrides.kind ?? 'BUILD',
      status: overrides.status ?? 'QUEUED',
      idempotencyKey: overrides.idempotencyKey ?? `job-${uniqueSuffix()}`,
      creditsChargedAt: overrides.creditsChargedAt ?? null,
    },
  });
}
