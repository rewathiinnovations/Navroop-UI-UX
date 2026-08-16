'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import {
  disconnectGitHubForUser,
  getGitHubConnectionStatusForUser,
  upsertGitHubConnection as upsertGitHubConnectionRow,
} from '@/lib/github/connection';
import { pushProjectToGitHubForUser, type PushDeps } from '@/lib/github/push';

async function requireActor() {
  const stored = peekActor();
  if (stored) return { user: stored, error: null as string | null, status: 200 as const };
  const user = await getSessionUser();
  if (!user) {
    return { user: null, error: 'Sign in required' as const, status: 401 as const };
  }
  return { user, error: null, status: 200 as const };
}

export async function getGitHubConnectionStatus(userId: string) {
  return getGitHubConnectionStatusForUser(prisma, userId);
}

export async function disconnectGitHub() {
  const { user, error, status } = await requireActor();
  if (!user) return { ok: false as const, error, status };
  await disconnectGitHubForUser(prisma, user.id);
  revalidatePath('/connectors');
  return { ok: true as const, data: { disconnected: true as const } };
}

export async function upsertGitHubConnection(input: {
  userId: string;
  githubUserId: string;
  githubUsername: string;
  accessToken: string;
  scope: string;
}) {
  await upsertGitHubConnectionRow(prisma, input);
}

export async function pushProjectToGitHub(projectId: string, deps?: PushDeps) {
  const { user, error, status } = await requireActor();
  if (!user) return { ok: false as const, error, status };
  const result = await pushProjectToGitHubForUser(prisma, user, projectId, deps);
  if (result.ok) {
    revalidatePath(`/project/${projectId}`);
  }
  return result;
}
