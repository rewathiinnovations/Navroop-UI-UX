import { decrypt, encrypt } from '../crypto';

export const CONNECT_FIRST_MESSAGE = 'Connect your GitHub account first';

type GithubConnectionDelegate = {
  findUnique: (args: {
    where: { userId: string };
    select?: { githubUsername?: boolean; accessTokenEncrypted?: boolean };
  }) => Promise<{ githubUsername: string; accessTokenEncrypted?: string } | null>;
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

export async function decryptCallerAccessToken(db: GithubConnectionDb, userId: string) {
  const row = await db.gitHubConnection.findUnique({
    where: { userId },
    select: { githubUsername: true, accessTokenEncrypted: true },
  });
  if (!row?.accessTokenEncrypted) return null;
  return decrypt(row.accessTokenEncrypted);
}
