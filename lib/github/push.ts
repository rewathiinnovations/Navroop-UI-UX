import { CONNECT_FIRST_MESSAGE, decryptCallerAccessToken } from './connection';
import { buildRepoFiles } from '@/lib/deploy/repo-files';
import { getCurrentProjectFiles } from './current-files';
import { createPrivateRepo, pushViaGitDataApi, type GithubFetch } from './git-data';
import { uniqueRepoName } from './repo-name';
import { trySandboxGitPush } from './sandbox-git';

export { CONNECT_FIRST_MESSAGE };

export const GITHUB_REAUTH_MESSAGE =
  'GitHub rejected the saved credentials. Reconnect GitHub from Connectors (or Admin → Configuration) and push again.';

/**
 * GitHub answers an expired or revoked token with "Bad credentials", which is
 * true and useless — it reads like the push was malformed and says nothing
 * about what to do. A live push failed exactly this way while the connector
 * still showed CONNECTED, so the studio insisted GitHub was fine.
 */
export function isGitHubAuthFailure(message: string): boolean {
  return /bad credentials|requires authentication|401|token .*(expired|revoked)/i.test(message);
}

function pushFailureMessage(message: string): string {
  return isGitHubAuthFailure(message) ? GITHUB_REAUTH_MESSAGE : message;
}

/**
 * Record a rejected token against the connector so /connectors and the health
 * page stop reporting CONNECTED. Best effort — a push already failed, and
 * failing to write the note must not replace that error with a worse one.
 */
async function noteGitHubAuthFailure(message: string): Promise<void> {
  if (!isGitHubAuthFailure(message)) return;
  try {
    const [{ prisma }, { WORKSPACE_ROW_ID }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/storage/usage'),
    ]);
    await prisma.integration.updateMany({
      where: { workspaceId: WORKSPACE_ROW_ID, kind: 'GITHUB_DEPLOY' },
      data: { status: 'ERROR', lastError: GITHUB_REAUTH_MESSAGE, lastCheckedAt: new Date() },
    });
  } catch {
    /* the push error is the one that matters */
  }
}

export type PushActor = { id: string; role: string };

export type PushDeps = {
  githubFetch?: GithubFetch;
  getFiles?: (project: {
    lastCode: string | null;
  }) => Promise<Record<string, string>> | Record<string, string>;
  trySandboxGit?: (input: { token: string; fullName: string }) => Promise<boolean>;
};

type PushDb = {
  gitHubConnection: {
    findUnique: (args: {
      where: { userId: string };
      select?: { githubUsername?: boolean; accessTokenEncrypted?: boolean };
    }) => Promise<{ githubUsername: string; accessTokenEncrypted?: string } | null>;
  };
  project: {
    findFirst: (args: {
      where: { id: string; deletedAt: null };
      select: {
        id: true;
        name: true;
        ownerId: true;
        stack: true;
        lastCode: true;
        githubRepoFullName: true;
        githubRepoUrl: true;
      };
    }) => Promise<{
      id: string;
      name: string;
      ownerId: string;
      stack: string;
      lastCode: string | null;
      githubRepoFullName: string | null;
      githubRepoUrl: string | null;
    } | null>;
    update: (args: {
      where: { id: string };
      data: {
        githubRepoFullName?: string;
        githubRepoUrl?: string;
        lastPushedAt?: Date;
      };
    }) => Promise<unknown>;
  };
};

function canMutate(user: PushActor, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

export async function pushProjectToGitHubForUser(
  db: PushDb,
  user: PushActor,
  projectId: string,
  deps: PushDeps = {},
) {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      name: true,
      ownerId: true,
      stack: true,
      lastCode: true,
      githubRepoFullName: true,
      githubRepoUrl: true,
    },
  });
  if (!project) {
    return { ok: false as const, error: 'Project not found', status: 404 as const };
  }
  if (!canMutate(user, project.ownerId)) {
    return { ok: false as const, error: 'Forbidden', status: 403 as const };
  }

  const token = await decryptCallerAccessToken(db, user.id);
  if (!token) {
    return { ok: false as const, error: CONNECT_FIRST_MESSAGE, status: 400 as const };
  }

  const generated = deps.getFiles
    ? await deps.getFiles({ lastCode: project.lastCode })
    : getCurrentProjectFiles(project);
  if (!generated || Object.keys(generated).length === 0) {
    return { ok: false as const, error: 'No project files to push', status: 400 as const };
  }
  // Push a repository, not a folder of components: the stack scaffold,
  // Dockerfile and ignore files go with it so the push is deployable as-is.
  const files = buildRepoFiles(project.stack, generated, { projectName: project.name });

  const githubFetch = deps.githubFetch ?? fetch;
  let fullName = project.githubRepoFullName;
  let htmlUrl = project.githubRepoUrl;

  if (!fullName) {
    try {
      const created = await createPrivateRepo(githubFetch, token, uniqueRepoName(project.name));
      fullName = created.fullName;
      htmlUrl = created.htmlUrl;
      await db.project.update({
        where: { id: project.id },
        data: { githubRepoFullName: fullName, githubRepoUrl: htmlUrl },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create GitHub repository';
      await noteGitHubAuthFailure(message);
      return { ok: false as const, error: pushFailureMessage(message), status: 502 as const };
    }
  }

  const tryGit = deps.trySandboxGit ?? trySandboxGitPush;
  try {
    const pushedViaGit = await tryGit({ token, fullName });
    if (!pushedViaGit) {
      await pushViaGitDataApi({ githubFetch, token, fullName, files });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not push to GitHub';
    await noteGitHubAuthFailure(message);
    return {
      ok: false as const,
      error: pushFailureMessage(message),
      status: 502 as const,
      data: { githubRepoFullName: fullName, githubRepoUrl: htmlUrl },
    };
  }

  const lastPushedAt = new Date();
  await db.project.update({
    where: { id: project.id },
    data: { lastPushedAt },
  });

  return {
    ok: true as const,
    data: {
      githubRepoFullName: fullName,
      githubRepoUrl: htmlUrl,
      lastPushedAt,
    },
  };
}
