import { uniqueSuffix } from './ids';

export type ProjectFactoryDb = {
  project: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; name: string; ownerId: string }>;
  };
};

export async function createProject(
  db: ProjectFactoryDb,
  overrides: { ownerId: string; name?: string; stack?: string; phase?: string },
) {
  const suffix = uniqueSuffix();
  return db.project.create({
    data: {
      name: overrides.name ?? `Project ${suffix}`,
      initialPrompt: 'A simple landing page',
      ownerId: overrides.ownerId,
      stack: overrides.stack ?? 'NEXTJS',
      phase: overrides.phase ?? 'PLANNING',
    },
  });
}
