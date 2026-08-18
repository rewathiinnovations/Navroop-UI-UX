import { uniqueSuffix } from './ids';

export type CheckpointFactoryDb = {
  checkpoint: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; projectId: string }>;
  };
};

export async function createCheckpoint(
  db: CheckpointFactoryDb,
  overrides: { projectId: string; isBookmarked?: boolean; fileSnapshot?: Record<string, string> | null },
) {
  return db.checkpoint.create({
    data: {
      projectId: overrides.projectId,
      label: `Checkpoint ${uniqueSuffix()}`,
      trigger: 'manual',
      isBookmarked: overrides.isBookmarked ?? false,
      fileSnapshot: overrides.fileSnapshot ?? { 'src/App.tsx': 'export default function App(){return null}' },
    },
  });
}
