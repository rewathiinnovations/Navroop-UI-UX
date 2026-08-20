import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "A new checkpoint of the current state is created first, so nothing is lost."
 *
 * That is what the Restore dialog said. The code wrote the old files back first
 * (`writeCheckpointFiles`) and only then called `createCheckpoint(trigger: 'restore')`,
 * which snapshots the tree that was *just restored* — `captureFileSnapshot` re-reads
 * `lastCode`. No checkpoint of the pre-restore state was ever created, so the promise was
 * false in the one case where it matters: restoring while the live files differ from the
 * newest checkpoint, which is exactly the state "Preview this version" produces (F-103).
 *
 * Goes red if the pre-restore snapshot stops being taken, if it is taken after the write
 * (the order assertion), or if it starts being taken when there is nothing to save.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointCreate: vi.fn(),
  checkpointUpdate: vi.fn(),
  checkpointDelete: vi.fn(),
  checkpointFindUniqueOrThrow: vi.fn(),
  executeRaw: vi.fn(),
}));
const snapshot = vi.hoisted(() => ({ capture: vi.fn(), read: vi.fn(), write: vi.fn() }));
const order = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: {
      findFirst: db.checkpointFindFirst,
      create: db.checkpointCreate,
      update: db.checkpointUpdate,
      delete: db.checkpointDelete,
      findUniqueOrThrow: db.checkpointFindUniqueOrThrow,
    },
    // `restoreCheckpoint` clears `Project.previewingCheckpointId` (F-102), written with raw
    // SQL because the generated client may predate the column.
    $executeRaw: db.executeRaw,
  },
  Prisma: { DbNull: null },
}));
vi.mock('@/generated/prisma', () => ({ Prisma: { DbNull: null } }));
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: 'user_owner', role: 'MEMBER', email: 'owner@example.com' }),
}));
vi.mock('@/lib/generation/conversation-state', () => ({ peekConversationState: () => null }));
vi.mock('@/lib/projects/lock', () => ({
  bumpContentVersion: vi.fn(),
  withProjectLock: async (_id: string, _actor: string, _kind: string, run: () => unknown) => ({
    ok: true as const,
    value: await run(),
  }),
}));
vi.mock('@/lib/storage', () => ({ deleteObject: vi.fn() }));
vi.mock('@/lib/storage/usage', () => ({
  adjustStorageBytes: vi.fn(),
  WORKSPACE_ROW_ID: 'ws_default',
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/signals/collect', () => ({ recordRevertRate: () => undefined }));
vi.mock('@/lib/preview/production', () => ({ buildPreviewForProject: async () => undefined }));
vi.mock('@/lib/checkpoints/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpoints/snapshot')>();
  return {
    ...actual,
    captureFileSnapshot: snapshot.capture,
    readSnapshot: snapshot.read,
    writeSnapshot: snapshot.write,
  };
});

const { restoreCheckpoint } = await import('@/lib/checkpoints/actions.ts');

const PROJECT = 'proj_restore_promise';
const CHECKPOINT = 'cp_old';

/** The version being restored to. */
const OLD_FILES = [{ path: 'src/App.jsx', content: 'export const version = 1;' }];
/** What is live right now — drifted from every checkpoint, so it is the thing at risk. */
const LIVE_FILES = [{ path: 'src/App.jsx', content: 'export const version = 7;' }];

beforeEach(() => {
  for (const mock of [...Object.values(db), ...Object.values(snapshot)]) mock.mockReset();
  order.events.length = 0;

  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: 'user_owner', previewUrl: null });
  db.checkpointFindFirst.mockResolvedValue({
    id: CHECKPOINT,
    projectId: PROJECT,
    label: 'Latest generation',
    thumbnailUrl: null,
    createdAt: new Date('2026-08-18T02:00:00.000Z'),
    trigger: 'followup',
    sourceMessage: null,
    isBookmarked: false,
    snapshotPruned: false,
    snapshotKey: `snapshots/${PROJECT}/${CHECKPOINT}.json.gz`,
    fileSnapshot: null,
  });
  snapshot.read.mockResolvedValue(OLD_FILES);
  snapshot.capture.mockResolvedValue(LIVE_FILES);
  snapshot.write.mockResolvedValue({
    snapshotKey: 'snapshots/x.json.gz',
    snapshotBytes: 128,
    snapshotFileCount: 1,
  });
  db.checkpointCreate.mockImplementation(async (args: { data: { label: string } }) => {
    order.events.push(`checkpoint:${args.data.label}`);
    return { id: `cp_${order.events.length}` };
  });
  db.checkpointUpdate.mockResolvedValue(undefined);
  db.checkpointFindUniqueOrThrow.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      label: 'Restored',
      thumbnailUrl: null,
      createdAt: new Date('2026-08-20T02:00:00.000Z'),
      trigger: 'restore',
      sourceMessage: null,
      isBookmarked: false,
      snapshotPruned: false,
    }),
  );
  db.projectUpdate.mockImplementation(async () => {
    order.events.push('write:lastCode');
    return undefined;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreCheckpoint keeps the promise the dialog makes', () => {
  it('snapshots the current files before replacing them', async () => {
    const result = await restoreCheckpoint(PROJECT, CHECKPOINT);

    expect(result.ok).toBe(true);
    const write = order.events.indexOf('write:lastCode');
    const preRestore = order.events.findIndex((event) => event.startsWith('checkpoint:Before'));
    expect(preRestore).toBeGreaterThan(-1);
    expect(preRestore).toBeLessThan(write);
  });

  it('still records the restore point after the write', async () => {
    await restoreCheckpoint(PROJECT, CHECKPOINT);

    const write = order.events.indexOf('write:lastCode');
    const restorePoint = order.events.findIndex((event) => event.startsWith('checkpoint:Restored'));
    expect(restorePoint).toBeGreaterThan(write);
  });

  // Control: the safety copy costs a gzip upload and a row, so it is only worth taking
  // when the live files are not already in the newest checkpoint. Without this, every
  // restore would double the storage it writes.
  it('control: takes no extra snapshot when the live files are already checkpointed', async () => {
    snapshot.capture.mockResolvedValue(OLD_FILES);

    await restoreCheckpoint(PROJECT, CHECKPOINT);

    expect(order.events.filter((event) => event.startsWith('checkpoint:Before'))).toEqual([]);
    expect(order.events).toContain('write:lastCode');
  });
});

describe('the Restore dialog describes what the code does', () => {
  const panel = readFileSync(
    fileURLToPath(new URL('../../components/workspace/VersionHistoryPanel.tsx', import.meta.url)),
    'utf8',
  );

  it('does not promise a sandbox that no longer exists', () => {
    expect(panel).not.toMatch(/sandbox/i);
  });

  it('still tells the person their current state is saved', () => {
    expect(panel).toMatch(/saved first/i);
  });
});
