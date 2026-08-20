import { decrypt, encrypt } from '../crypto';

export const CONNECT_FIRST_MESSAGE = 'Connect your GitHub account first';

/**
 * The scopes a private-repo push actually needs from a classic OAuth token.
 *
 * `repo` is broad — read/write to every private repository the user can reach — and F-271
 * records that as the standing cost of this flow: `createPrivateRepo` + `pushViaGitDataApi`
 * cannot work on a private repository with anything narrower from an OAuth App. The
 * least-privilege replacement is a user-to-server token from the connectors GitHub App
 * (`githubConnectorsManifest` already defines it), whose per-repository permissions carry no
 * scope string at all — which is why an empty scope is treated as "not an OAuth grant" below
 * rather than as "no permission".
 */
export const GITHUB_PUSH_SCOPES = ['repo'] as const;

export const GITHUB_INSUFFICIENT_SCOPE_MESSAGE =
  'The saved GitHub authorisation cannot create or write private repositories. Disconnect and reconnect GitHub from Connectors, and approve the repository permission.';

/**
 * Whether the *recorded grant* covers a private-repo push.
 *
 * This used to be unknowable: the callback stored `tokenJson.scope || 'repo'`, so a token
 * that GitHub had granted nothing to was filed as a full `repo` grant, and nothing read the
 * column before pushing either way. The push then failed several API calls later with
 * GitHub's "Resource not accessible", which names neither the cause nor the fix (F-271).
 *
 * An empty scope means the token is not a classic OAuth grant (GitHub App user-to-server
 * tokens carry no scope list), so it is allowed through to GitHub, which is the only thing
 * that can judge it.
 */
export function scopeAllowsPrivatePush(scope: string | null | undefined): boolean {
  const granted = (scope ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (granted.length === 0) return true;
  return GITHUB_PUSH_SCOPES.every((needed) => granted.includes(needed));
}

type GithubConnectionDelegate = {
  findUnique: (args: {
    where: { userId: string };
    select?: { githubUsername?: boolean; accessTokenEncrypted?: boolean; scope?: boolean };
  }) => Promise<{ githubUsername: string; accessTokenEncrypted?: string; scope?: string } | null>;
  upsert: (args: {
    where: { userId: string };
    create: {
      userId: string;
      githubUserId: string;
      githubUsername: string;
      accessTokenEncrypted: string;
      scope: string;
    };
    update: {
      githubUserId: string;
      githubUsername: string;
      accessTokenEncrypted: string;
      scope: string;
      connectedAt: Date;
    };
  }) => Promise<unknown>;
  deleteMany: (args: { where: { userId: string } }) => Promise<unknown>;
};

export type GithubConnectionDb = {
  gitHubConnection: GithubConnectionDelegate;
};

export async function upsertGitHubConnection(
  db: GithubConnectionDb,
  input: {
    userId: string;
    githubUserId: string;
    githubUsername: string;
    accessToken: string;
    scope: string;
  },
) {
  const accessTokenEncrypted = encrypt(input.accessToken);
  return db.gitHubConnection.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      githubUserId: input.githubUserId,
      githubUsername: input.githubUsername,
      accessTokenEncrypted,
      scope: input.scope,
    },
    update: {
      githubUserId: input.githubUserId,
      githubUsername: input.githubUsername,
      accessTokenEncrypted,
      scope: input.scope,
      connectedAt: new Date(),
    },
  });
}

export async function getGitHubConnectionStatusForUser(db: GithubConnectionDb, userId: string) {
  const row = await db.gitHubConnection.findUnique({
    where: { userId },
    select: { githubUsername: true },
  });
  if (!row) return { connected: false as const };
  return { connected: true as const, githubUsername: row.githubUsername };
}

export async function disconnectGitHubForUser(db: GithubConnectionDb, userId: string) {
  await db.gitHubConnection.deleteMany({ where: { userId } });
}

/**
 * Returns the caller's token *and the grant recorded with it*, so the push can refuse a
 * demonstrably insufficient authorisation before it creates anything (F-271).
 */
export async function readCallerGithubAuth(
  db: { gitHubConnection: Pick<GithubConnectionDelegate, 'findUnique'> },
  userId: string,
): Promise<{ token: string; scope: string } | null> {
  const row = await db.gitHubConnection.findUnique({
    where: { userId },
    select: { githubUsername: true, accessTokenEncrypted: true, scope: true },
  });
  if (!row?.accessTokenEncrypted) return null;
  return { token: decrypt(row.accessTokenEncrypted), scope: row.scope ?? '' };
}
