/**
 * Nothing to snapshot is an outcome, not a fault.
 *
 * A reply with zero files is now a legitimate answer turn ("hello" on a project
 * with no site yet), and it ends with the same terminal `status: 'ready'` PATCH as
 * a real build. That walked into `captureFileSnapshot`, which reads only
 * `Project.lastCode`, and threw "Cannot create checkpoint: file snapshot is
 * empty". `persistProjectGeneration` caught and logged it, so every ordinary chat
 * message on an empty project wrote an error line — noise that hides real ones.
 *
 * `null` is already the "no checkpoint written" answer (dedupe returns it), so
 * callers needed no change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  checkpointFindFirst: vi.fn(),
  planFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    checkpoint: { findFirst: db.checkpointFindFirst },
    projectPlan: { findFirst: db.planFindFirst },
  },
}));

// `peekActor` supplies the actor; next-auth cannot resolve `next/server` outside
// the Next runtime, which is why the sibling checkpoint suites stub both.
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: 'u-owner', email: 'o@example.com', name: 'Owner', role: 'MEMBER' }),
}));
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));

const snapshot = vi.hoisted(() => ({ capture: vi.fn(), equal: vi.fn(() => false) }));
vi.mock('@/lib/checkpoints/snapshot', () => ({
  captureFileSnapshot: snapshot.capture,
  snapshotsEqual: snapshot.equal,
  readSnapshot: vi.fn(async () => []),
  writeSnapshot: vi.fn(),
  asFileSnapshot: (value: unknown) => value,
  SnapshotReadError: class SnapshotReadError extends Error {},
}));

// Dynamic so every vi.mock above registers before the module graph is evaluated.
const { createCheckpointAfterGeneration } = await import('@/lib/checkpoints/actions');

const PROJECT = 'proj_empty_snapshot';

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.equal.mockReturnValue(false);
  db.checkpointFindFirst.mockResolvedValue(null);
  db.planFindFirst.mockResolvedValue(null);
  db.projectFindFirst.mockResolvedValue({ initialPrompt: 'build it' });
});

describe('createCheckpointAfterGeneration with nothing to save', () => {
  it('answers null instead of throwing', async () => {
    snapshot.capture.mockResolvedValue([]);

    await expect(
      createCheckpointAfterGeneration(PROJECT, { previousPhase: 'COMPLETE' }),
    ).resolves.toBeNull();
  });

  // The write-when-there-are-files path is covered end to end against a real
  // database by tests/integration/preview-persist-once.test.ts. `createCheckpoint`
  // lives in this same module, so pinning it here would mean mocking Prisma's
  // writer rather than testing the decision this file is about.

  it('keeps dedupe: an unchanged snapshot writes nothing', async () => {
    snapshot.capture.mockResolvedValue([{ path: 'app/page.tsx', content: 'x' }]);
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k', fileSnapshot: null });
    snapshot.equal.mockReturnValue(true);

    await expect(
      createCheckpointAfterGeneration(PROJECT, { previousPhase: 'COMPLETE' }),
    ).resolves.toBeNull();
  });
});
