import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { last4FromSecret } from '@/lib/api-keys';
import { NO_SERVER_MESSAGE } from '@/lib/publish/constants';
import { testServerConnection, type CoolifyServerAuth } from './client';

export function encryptServerToken(token: string) {
  return encrypt(token);
}

export function decryptServerToken(stored: string) {
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
}

export function serverAuth(row: { apiUrl: string; apiToken: string }): CoolifyServerAuth {
  return { apiUrl: row.apiUrl, apiToken: decryptServerToken(row.apiToken) };
}

export function publicServer(row: {
  id: string;
  name: string;
  apiUrl: string;
  apiToken: string;
  serverIp: string;
  projectUuid: string;
  isActive: boolean;
  maxDeployments: number;
  createdAt: Date;
  _count?: { deployments: number };
}) {
  const token = decryptServerToken(row.apiToken);
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.apiUrl,
    serverIp: row.serverIp,
    projectUuid: row.projectUuid,
    isActive: row.isActive,
    maxDeployments: row.maxDeployments,
    createdAt: row.createdAt,
    last4: last4FromSecret(token),
    deploymentCount: row._count?.deployments ?? 0,
  };
}

/** Active server with the fewest non-STOPPED deployments, under maxDeployments. */
export async function pickCoolifyServer() {
  const servers = await prisma.coolifyServer.findMany({
    where: { isActive: true },
  });
  if (servers.length === 0) {
    throw new Error(NO_SERVER_MESSAGE);
  }

  const ranked = await Promise.all(
    servers.map(async (server) => {
      const active = await prisma.deployment.count({
        where: { serverId: server.id, status: { not: 'STOPPED' } },
      });
      return { server, active };
    }),
  );

  const eligible = ranked
    .filter((row) => row.active < row.server.maxDeployments)
    .sort((a, b) => a.active - b.active);

  if (eligible.length === 0) {
    throw new Error(NO_SERVER_MESSAGE);
  }
  return eligible[0].server;
}

export async function testStoredServer(id: string) {
  const row = await prisma.coolifyServer.findUnique({ where: { id } });
  if (!row) return { ok: false as const, error: 'Server not found', status: 404 };
  return testServerConnection(serverAuth(row));
}
