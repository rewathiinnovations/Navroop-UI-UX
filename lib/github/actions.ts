'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import { disconnectGitHubForUser } from '@/lib/github/connection';
import { pushProjectToGitHubForUser, type PushDeps } from '@/lib/github/push';

/**
 * Every export of a `'use server'` module is a public HTTP endpoint: Next assigns
 * it an action id that ships in the client bundle, so anyone who can POST to the
 * page can invoke it, signed in or not. Two exports here forgot that.
 *
 * `upsertGitHubConnection({ userId, accessToken, … })` took both the target user
 * and the token from its caller and checked nothing, so an unauthenticated
 * request could staple an attacker's GitHub token onto any account — and then
 * push through it. It had no callers at all: `app/api/github/callback/route.ts`
 * imports the real writer from `lib/github/connection.ts`. It existed purely as
 * that hole, so it is gone rather than gated.
 *
 * `getGitHubConnectionStatus(userId)` likewise answered for any user id. Its
 * three callers are all server-side and each already resolves the id from the
 * session, so they now import `getGitHubConnectionStatusForUser` from
 * `lib/github/connection.ts` directly — a plain function, not an endpoint.
 *
 * What stays here MUST derive the actor from the session, never from arguments.
 */
async function requireActor() {
  const stored = peekActor();
  if (stored) return { user: stored, error: null as string | null, status: 200 as const };
  const user = await getSessionUser();
  if (!user) {
    return { user: null, error: 'Sign in required' as const, status: 401 as const };
  }
  return { user, error: null, status: 200 as const };
}

export async function disconnectGitHub() {
  const { user, error, status } = await requireActor();
  if (!user) return { ok: false as const, error, status };
  await disconnectGitHubForUser(prisma, user.id);
  revalidatePath('/connectors');
  return { ok: true as const, data: { disconnected: true as const } };
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
