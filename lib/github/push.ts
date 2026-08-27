import {
  CONNECT_FIRST_MESSAGE,
  GITHUB_INSUFFICIENT_SCOPE_MESSAGE,
  readCallerGithubAuth,
  scopeAllowsPrivatePush,
} from './connection';
import { clearGitHubConnectionError, noteGitHubConnectionError } from './connection-error';
import { buildRepoFiles } from '@/lib/deploy/repo-files';
import { getCurrentProjectFiles } from './current-files';
import { createPrivateRepo, pushViaGitDataApi, type GithubFetch } from './git-data';
import { uniqueRepoName } from './repo-name';

export { CONNECT_FIRST_MESSAGE };

export const GITHUB_REAUTH_MESSAGE =
  'GitHub rejected the saved credentials. Disconnect and reconnect GitHub from Connectors, then push again.';

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
 * Record a rejected token against the *connection that was rejected* — this member's
 * `GitHubConnection` row — so `/connectors` stops telling them they are connected.
 *
 * It used to write `status: 'ERROR'` onto the workspace-wide `GITHUB_DEPLOY` Integration,
 * which holds the GitHub App credentials publish uses and has nothing to do with any member's
 * personal OAuth grant. Since the publish gate counts only CONNECTED, one member's expired
 * authorisation blocked publishing for the whole workspace and pointed an admin at an App
 * that was never broken (F-206). The deploy App's status may only be written by a check that
 * actually exercised the App's credentials (F-212).
 */
async function noteGitHubAuthFailure(userId: string, message: string): Promise<void> {
  if (!isGitHubAuthFailure(message)) return;
  await noteGitHubConnectionError(userId, GITHUB_REAUTH_MESSAGE);
}

export type PushActor = { id: string; role: string };

export type PushDeps = {
  githubFetch?: GithubFetch;
  getFiles?: (project: {
    lastCode: string | null;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Explicit opt-in to replace the repository contents and force-move `main`
   * (F-210). Default false: the push is a child commit over the current head
   * and refuses when the remote moved. No UI sets this yet; a future toggle on
   * the Connectors push button would thread it through `pushProjectToGitHub`.
   */
  force?: boolean;
};

type PushDb = {
  gitHubConnection: {
    findUnique: (args: {
      where: { userId: string };
      select?: { githubUsername?: boolean; accessTokenEncrypted?: boolean; scope?: boolean };
    }) => Promise<{ githubUsername: string; accessTokenEncrypted?: string; scope?: string } | null>;
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
        designDirection: true;
        githubRepoFullName: true;
        githubRepoUrl: true;
      };
    }) => Promise<{
      id: string;
      name: string;
      ownerId: string;
      stack: string;
      lastCode: string | null;
      designDirection: string | null;
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
      designDirection: true,
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

  const auth = await readCallerGithubAuth(db, user.id);
  if (!auth) {
    return { ok: false as const, error: CONNECT_FIRST_MESSAGE, status: 400 as const };
  }
  // Refuse a grant that provably cannot do this before creating anything (F-271). GitHub
  // would otherwise answer "Resource not accessible" from inside `createPrivateRepo`, which
  // names neither the cause nor the fix.
  if (!scopeAllowsPrivatePush(auth.scope)) {
    return { ok: false as const, error: GITHUB_INSUFFICIENT_SCOPE_MESSAGE, status: 400 as const };
  }
  const token = auth.token;

  const generated = deps.getFiles
    ? await deps.getFiles({ lastCode: project.lastCode })
    : getCurrentProjectFiles(project);
  if (!generated || Object.keys(generated).length === 0) {
    return { ok: false as const, error: 'No project files to push', status: 400 as const };
  }
  // Push a repository, not a folder of components: the stack scaffold,
  // Dockerfile and ignore files go with it so the push is deployable as-is.
  const files = buildRepoFiles(project.stack, generated, {
    projectName: project.name,
    designDirection: project.designDirection,
  });

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
      await noteGitHubAuthFailure(user.id, message);
      return { ok: false as const, error: pushFailureMessage(message), status: 502 as const };
    }
  }

  try {
    await pushViaGitDataApi({ githubFetch, token, fullName, files, force: deps.force === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not push to GitHub';
    await noteGitHubAuthFailure(user.id, message);
    return {
      ok: false as const,
      error: pushFailureMessage(message),
      status: 502 as const,
      data: { githubRepoFullName: fullName, githubRepoUrl: htmlUrl },
    };
  }

  // This member's grant demonstrably works, so any earlier rejection note is stale. Cleared
  // here rather than only on reconnect: a token that started working again (a re-authorised
  // App install, a restored network) would otherwise keep warning them on /connectors.
  await clearGitHubConnectionError(user.id);
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
