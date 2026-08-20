import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-206: one member's dead personal token must not take publishing down for everyone.
 *
 * The Connectors push uses a *per-user* OAuth token. When GitHub rejected it,
 * `noteGitHubAuthFailure` wrote `status: 'ERROR'` onto the workspace-wide `GITHUB_DEPLOY`
 * integration — the row that holds the GitHub *App* credentials publish uses, which that
 * member's token has nothing to do with. `missingIntegrationKinds` counts only CONNECTED,
 * so the next publish by anyone answered "GitHub is not connected", and the message told an
 * admin to reconnect an App that was never broken.
 *
 * The failure belongs on the row that failed: `GitHubConnection.lastError` for that user.
 * F-212 established that an integration may only report a credential problem it actually
 * exercised; this is the same rule pointed at the personal connection.
 */

const db = vi.hoisted(() => ({
  integrationUpdateMany: vi.fn(),
  integrationUpdate: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    integration: { updateMany: db.integrationUpdateMany, update: db.integrationUpdate },
    $executeRaw: db.executeRaw,
    $queryRaw: db.queryRaw,
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

/** Reassembles a tagged-template statement so a test can read the SQL that was sent. */
function rawSql(call: unknown[] | undefined): string {
  const strings = call?.[0] as { raw?: readonly string[] } | undefined;
  return (strings?.raw ?? []).join('?').replace(/\s+/g, ' ').trim();
}

const USER = { id: 'u-member', role: 'MEMBER' };
const PROJECT_ROW = {
  id: 'p-1',
  name: 'Shop',
  ownerId: USER.id,
  stack: 'NEXTJS',
  lastCode: JSON.stringify({ files: { 'src/App.jsx': 'x' } }),
  githubRepoFullName: 'member/shop',
  githubRepoUrl: 'https://github.com/member/shop',
};

function pushDb() {
  return {
    gitHubConnection: {
      findUnique: vi.fn(async () => ({
        githubUsername: 'member',
        accessTokenEncrypted: 'enc:ghu_dead',
        scope: 'repo',
      })),
    },
    project: {
      findFirst: vi.fn(async () => PROJECT_ROW),
      update: vi.fn(async () => undefined),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.executeRaw.mockResolvedValue(1);
  db.queryRaw.mockResolvedValue([]);
  db.integrationUpdateMany.mockResolvedValue({ count: 1 });
});

describe('a rejected personal token is recorded against that member', () => {
  it('does not touch the workspace GITHUB_DEPLOY integration', async () => {
    const { pushProjectToGitHubForUser } = await import('@/lib/github/push');

    const result = await pushProjectToGitHubForUser(pushDb(), USER, PROJECT_ROW.id, {
      trySandboxGit: async () => {
        throw new Error('Bad credentials');
      },
    });

    expect(result.ok).toBe(false);
    // The exact bug: an org-wide row flipped to ERROR by one member's expired grant.
    expect(db.integrationUpdateMany).not.toHaveBeenCalled();
    expect(db.integrationUpdate).not.toHaveBeenCalled();
  });

  it('writes the failure to that user GitHubConnection row', async () => {
    const { pushProjectToGitHubForUser } = await import('@/lib/github/push');

    await pushProjectToGitHubForUser(pushDb(), USER, PROJECT_ROW.id, {
      trySandboxGit: async () => {
        throw new Error('Bad credentials');
      },
    });

    const write = db.executeRaw.mock.calls.find((call) =>
      rawSql(call).includes('"GitHubConnection"'),
    );
    expect(write).toBeDefined();
    expect(rawSql(write)).toContain('lastError');
    expect(write?.slice(1)).toContain(USER.id);
  });

  it('leaves both rows alone when the failure is not about credentials', async () => {
    const { pushProjectToGitHubForUser } = await import('@/lib/github/push');

    await pushProjectToGitHubForUser(pushDb(), USER, PROJECT_ROW.id, {
      trySandboxGit: async () => {
        throw new Error('Could not create git tree');
      },
    });

    expect(db.integrationUpdateMany).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it('clears the note once a push succeeds', async () => {
    const { pushProjectToGitHubForUser } = await import('@/lib/github/push');

    const result = await pushProjectToGitHubForUser(pushDb(), USER, PROJECT_ROW.id, {
      trySandboxGit: async () => true,
    });

    expect(result.ok).toBe(true);
    const clear = db.executeRaw.mock.calls.find((call) =>
      rawSql(call).includes('"GitHubConnection"'),
    );
    expect(rawSql(clear)).toContain('NULL');
  });
});

describe('the member sees their own failure', () => {
  it('reports a failure recorded after the current grant', async () => {
    db.queryRaw.mockResolvedValue([
      {
        lastError: 'GitHub rejected the saved credentials.',
        lastErrorAt: new Date('2026-08-21T10:00:00.000Z'),
        connectedAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    ]);
    const { readGitHubConnectionError } = await import('@/lib/github/connection-error');

    expect(await readGitHubConnectionError(USER.id)).toContain('GitHub rejected');
  });

  it('ignores a failure that predates a reconnect, so a fixed connection reads clean', async () => {
    db.queryRaw.mockResolvedValue([
      {
        lastError: 'GitHub rejected the saved credentials.',
        lastErrorAt: new Date('2026-08-01T09:00:00.000Z'),
        connectedAt: new Date('2026-08-21T10:00:00.000Z'),
      },
    ]);
    const { readGitHubConnectionError } = await import('@/lib/github/connection-error');

    expect(await readGitHubConnectionError(USER.id)).toBeNull();
  });

  it('reports nothing when there is no connection row at all', async () => {
    const { readGitHubConnectionError } = await import('@/lib/github/connection-error');

    expect(await readGitHubConnectionError(USER.id)).toBeNull();
  });
});
