import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  clearPreviewingCheckpoint,
  markPreviewingCheckpoint,
  readPreviewingCheckpointId,
} from '@/lib/checkpoints/preview-state';
import {
  clearGitHubConnectionError,
  noteGitHubConnectionError,
  readGitHubConnectionError,
} from '@/lib/github/connection-error';

/**
 * The raw SQL behind `Project.previewingCheckpointId` (F-102) and
 * `GitHubConnection.lastError` (F-206), against real Postgres.
 *
 * Both are written with `$executeRaw` for the reason `lib/publish/repo-guard.ts` records: the
 * generated Prisma client on a developer machine may predate the migration. That choice has
 * already cost this repo once — `createPlan` shipped a raw UPDATE with a stray comma before
 * its WHERE, so every create inserted the row and then threw `syntax error at or near "WHERE"`,
 * and no test noticed because nothing exercised the statement (see
 * `tests/integration/plan-admin-caps.test.ts`). A unit test over a mocked `$executeRaw`
 * asserts the mock, not the grammar, and would not have caught it either.
 *
 * So these cases run the statements. They also pin the parts that are logic rather than
 * syntax: the guarded UPDATEs answer with a row count, and `readGitHubConnectionError`
 * compares `lastErrorAt` against `connectedAt` so a reconnect retires an old note.
 */

const prisma = testPrismaClient();

const USER = 'user_preview_cols';
const OTHER_USER = 'user_preview_cols_other';
const PROJECT = 'proj_preview_cols';
const DELETED_PROJECT = 'proj_preview_cols_deleted';
const CHECKPOINT = 'cp_preview_cols';

async function seed() {
  for (const [id, email] of [
    [USER, 'preview-cols@example.com'],
    [OTHER_USER, 'preview-cols-other@example.com'],
  ] as const) {
    await prisma.user.upsert({
      where: { id },
      create: { id, email, name: id, role: 'MEMBER', passwordHash: 'not-a-real-hash' },
      update: {},
    });
  }
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'Preview columns', ownerId: USER, initialPrompt: 'p' },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: DELETED_PROJECT },
    create: {
      id: DELETED_PROJECT,
      name: 'Preview columns deleted',
      ownerId: USER,
      initialPrompt: 'p',
      deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
    update: { deletedAt: new Date('2026-08-01T00:00:00.000Z') },
  });
  await prisma.$executeRaw`
    UPDATE "Project" SET "previewingCheckpointId" = NULL WHERE id IN (${PROJECT}, ${DELETED_PROJECT})
  `;
  await prisma.gitHubConnection.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
}

beforeEach(async () => {
  await seed();
});

afterAll(async () => {
  await prisma.gitHubConnection.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, DELETED_PROJECT] } } });
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
  await prisma.$disconnect();
});

describe('Project.previewingCheckpointId', () => {
  it('round-trips through the marker and the reader', async () => {
    expect(await readPreviewingCheckpointId(PROJECT)).toBeNull();
    expect(await markPreviewingCheckpoint(PROJECT, CHECKPOINT)).toBe('marked');
    expect(await readPreviewingCheckpointId(PROJECT)).toBe(CHECKPOINT);
  });

  it('clears back to the current version, and reports whether it had to', async () => {
    await markPreviewingCheckpoint(PROJECT, CHECKPOINT);

    expect(await clearPreviewingCheckpoint(PROJECT)).toBe(true);
    expect(await readPreviewingCheckpointId(PROJECT)).toBeNull();
    // Idempotent, and honest about it: the second call changed nothing.
    expect(await clearPreviewingCheckpoint(PROJECT)).toBe(false);
  });

  it('refuses to mark a deleted project, rather than reporting a preview nothing serves', async () => {
    expect(await markPreviewingCheckpoint(DELETED_PROJECT, CHECKPOINT)).toBe('no-such-project');
    // The reader also excludes it, so the two agree on what a live project is.
    expect(await readPreviewingCheckpointId(DELETED_PROJECT)).toBeNull();
  });

  it('reports null for a project id that does not exist', async () => {
    expect(await readPreviewingCheckpointId('proj_preview_cols_absent')).toBeNull();
    expect(await markPreviewingCheckpoint('proj_preview_cols_absent', CHECKPOINT)).toBe(
      'no-such-project',
    );
  });
});

describe('GitHubConnection.lastError', () => {
  async function connect(userId: string, connectedAt: Date) {
    await prisma.gitHubConnection.create({
      data: {
        userId,
        githubUserId: `gh-${userId}`,
        githubUsername: userId,
        accessTokenEncrypted: 'enc',
        scope: 'repo',
        connectedAt,
      },
    });
  }

  it('records a rejection against one member and leaves the other alone', async () => {
    await connect(USER, new Date('2026-08-01T00:00:00.000Z'));
    await connect(OTHER_USER, new Date('2026-08-01T00:00:00.000Z'));

    await noteGitHubConnectionError(USER, 'GitHub rejected the saved credentials.');

    expect(await readGitHubConnectionError(USER)).toContain('GitHub rejected');
    // The whole point of F-206: one member's dead token is one member's problem.
    expect(await readGitHubConnectionError(OTHER_USER)).toBeNull();
  });

  it('retires the note when the member reconnects, with no second write', async () => {
    await connect(USER, new Date('2026-08-01T00:00:00.000Z'));
    await noteGitHubConnectionError(USER, 'GitHub rejected the saved credentials.');
    expect(await readGitHubConnectionError(USER)).not.toBeNull();

    // What `upsertGitHubConnection` does on a reconnect.
    await prisma.gitHubConnection.update({
      where: { userId: USER },
      data: { connectedAt: new Date(Date.now() + 60_000) },
    });

    expect(await readGitHubConnectionError(USER)).toBeNull();
  });

  it('clears the note explicitly, the way a successful push does', async () => {
    await connect(USER, new Date('2026-08-01T00:00:00.000Z'));
    await noteGitHubConnectionError(USER, 'GitHub rejected the saved credentials.');

    await clearGitHubConnectionError(USER);

    expect(await readGitHubConnectionError(USER)).toBeNull();
  });

  it('reports nothing for a member who has never connected', async () => {
    expect(await readGitHubConnectionError(USER)).toBeNull();
    // And noting a failure against a missing row is a no-op, not a throw: the caller is
    // already handling a failed push and must not be handed a second one.
    await expect(noteGitHubConnectionError(USER, 'Bad credentials')).resolves.toBeUndefined();
  });
});
