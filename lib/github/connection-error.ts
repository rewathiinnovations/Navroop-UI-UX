import { prisma } from '@/lib/db';

/**
 * F-206: where a rejected *personal* GitHub token is recorded.
 *
 * The Connectors push signs with `GitHubConnection.accessTokenEncrypted` — one row per user.
 * When GitHub rejected it, the failure was written to the workspace-wide `GITHUB_DEPLOY`
 * Integration as `status: 'ERROR'`. That row holds the GitHub *App* credentials publish uses,
 * which have nothing to do with any member's OAuth grant, and `missingIntegrationKinds` counts
 * only CONNECTED — so one member letting their authorisation lapse blocked publishing for the
 * entire workspace and told an admin to reconnect an App that was never broken.
 *
 * F-212 set the rule this follows: an integration's status may only be written by a check that
 * actually exercised that integration's credentials. A per-user push exercises the user's
 * token, so the note lands on the user's row.
 *
 * Raw SQL for the reason `lib/publish/repo-guard.ts` gives: the generated Prisma client on a
 * developer machine may predate the migration (regeneration is owned by the dev-server agent,
 * `single-dev-server.mdc`), and this has to be live either way.
 */

/**
 * Records a credential rejection against one member's connection.
 *
 * Best effort by contract: a push has already failed and its error is the one the user needs,
 * so a failure to write the note must not replace it with a worse one.
 */
export async function noteGitHubConnectionError(userId: string, message: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "GitHubConnection"
      SET "lastError" = ${message}, "lastErrorAt" = NOW()
      WHERE "userId" = ${userId}
    `;
  } catch {
    /* the push error is the one that matters */
  }
}

/** Clears the note after a push that worked, so the card stops warning about a live grant. */
export async function clearGitHubConnectionError(userId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "GitHubConnection"
      SET "lastError" = NULL, "lastErrorAt" = NULL
      WHERE "userId" = ${userId} AND "lastError" IS NOT NULL
    `;
  } catch {
    /* the push succeeded; a stale note is retired by the connectedAt comparison below */
  }
}

/**
 * The member's own outstanding connection problem, or null.
 *
 * A note only counts while it is newer than the grant it is about: `upsertGitHubConnection`
 * bumps `connectedAt` on every reconnect, so re-authorising retires an old note without any
 * code having to remember to clear it. Without that comparison a member who fixed their
 * connection would keep being told it was broken until the next successful push.
 */
export async function readGitHubConnectionError(userId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<
    Array<{ lastError: string | null; lastErrorAt: Date | null; connectedAt: Date | null }>
  >`
    SELECT "lastError", "lastErrorAt", "connectedAt"
    FROM "GitHubConnection" WHERE "userId" = ${userId}
  `;
  const row = rows[0];
  if (!row?.lastError || !row.lastErrorAt) return null;
  if (row.connectedAt && row.lastErrorAt.getTime() <= row.connectedAt.getTime()) return null;
  return row.lastError;
}
