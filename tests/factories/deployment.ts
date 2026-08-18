import { WORKSPACE_ROW_ID } from '../../lib/storage/usage';
import { uniqueSuffix } from './ids';

export type DeploymentFactoryDb = {
  coolifyServer: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  deployment: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; slug: string }>;
  };
};

export async function createDeployment(
  db: DeploymentFactoryDb,
  overrides: { projectId: string; publishedById: string; kind?: 'LIVE' | 'PREVIEW'; status?: string },
) {
  const suffix = uniqueSuffix();
  const server = await db.coolifyServer.create({
    data: {
      name: `server-${suffix}`,
      apiUrl: 'https://coolify.example',
      apiToken: 'encrypted-token',
      serverIp: '203.0.113.10',
      projectUuid: `uuid-${suffix}`,
    },
  });
  return db.deployment.create({
    data: {
      projectId: overrides.projectId,
      workspaceId: WORKSPACE_ROW_ID,
      serverId: server.id,
      kind: overrides.kind ?? 'LIVE',
      status: overrides.status ?? 'LIVE',
      slug: `site-${suffix}`,
      publishedById: overrides.publishedById,
    },
  });
}
