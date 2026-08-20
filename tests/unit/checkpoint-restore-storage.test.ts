import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the restore, preview and export paths say when the snapshot cannot be read.
 *
 * All three used `files.length === 0` as their only signal. `readSnapshot` answered `[]`
 * for a failed read, so restore and preview returned `prunedError()` — "Old checkpoint —
 * cannot restore", a 409 that tells the user their version is permanently gone and stops
 * them retrying — and export returned an empty file list, which the route streams as a
 * successful download of an empty ZIP.
 *
 * A storage failure now has its own answer: 503 with copy that says nothing was changed
 * and to try again. Genuine pruning keeps the 409, because that message is correct there.
 *
 * The SDK transport is stubbed, so nothing reaches ElasticLake or S3.
 *
 * Goes red if: a failed read collapses back onto the pruned answer (the 503 expectations
 * fail); the pruned answer stops being reachable (the 409 cases); or `collectExportFiles`
 * gains a catch that returns `[]`.
 */

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
}));
const actor = vi.hoisted(() => ({ peek: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class StubbedS3Client {
      readonly send = sdk.send;
    },
  };
});

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: { findFirst: db.checkpointFindFirst },
  },
}));

vi.mock('@/lib/projects/plan', () => ({ peekActor: actor.peek }));

/** next-auth cannot resolve `next/server` outside the Next runtime, and `peekActor`
 *  already supplies the actor, so `getSessionUser` is never reached. */
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));

/**
 * Restoring writes the snapshot back to Project.lastCode. The stub takes the lock for
 * granted but must keep the real `{ ok, value }` envelope: preview and exit now go
 * through the lock too, and a bare `run()` here would make them read `.ok` off the
 * work's own return value.
 */
vi.mock('@/lib/projects/lock', () => ({
  bumpContentVersion: vi.fn(),
  withProjectLock: async (_id: string, _actor: string, _kind: string, run: () => unknown) => ({
    ok: true as const,
    value: await run(),
  }),
}));

const { NoSuchKey, S3ServiceException } = await import('@aws-sdk/client-s3');
const { previewCheckpoint, exitCheckpointPreview, restoreCheckpoint } =
  await import('@/lib/checkpoints/actions.ts');
const { collectExportFiles } = await import('@/lib/export/collect.ts');

const PROJECT = 'proj_restore_copy';
const CHECKPOINT = 'cp_restore_copy';
const SNAPSHOT_KEY = `snapshots/${PROJECT}/${CHECKPOINT}.json.gz`;

const FILES = [
  { path: 'src/App.jsx', content: 'export default function App(){return <h1>Hi</h1>}' },
];

function accessDenied() {
  return new S3ServiceException({
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
    message: 'Access Denied',
  });
}

function absentKey() {
  return new NoSuchKey({
    $metadata: { httpStatusCode: 404 },
    message: 'The specified key does not exist.',
  });
}

function snapshotBody() {
  return {
    Body: {
      transformToByteArray: async () =>
        new Uint8Array(gzipSync(Buffer.from(JSON.stringify(FILES), 'utf8'))),
    },
  };
}

const ENV_KEYS = [
  'STORAGE_DRIVER',
  'ELK_ENDPOINT',
  'ELK_BUCKET',
  'ELK_ACCESS_KEY_ID',
  'ELK_SECRET_ACCESS_KEY',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  process.env.STORAGE_DRIVER = 's3';
  process.env.ELK_ENDPOINT = 'http://elk.invalid';
  process.env.ELK_BUCKET = 'navroop-test';
  process.env.ELK_ACCESS_KEY_ID = 'test-only';
  process.env.ELK_SECRET_ACCESS_KEY = 'test-only';

  sdk.send.mockReset();
  db.projectFindFirst.mockReset();
  db.checkpointFindFirst.mockReset();
  db.projectUpdate.mockReset();
  actor.peek.mockReturnValue({ id: 'user_owner', role: 'MEMBER', email: 'owner@example.com' });

  db.projectFindFirst.mockResolvedValue({
    id: PROJECT,
    ownerId: 'user_owner',
    sandboxId: null,
    previewUrl: null,
  });
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
    snapshotKey: SNAPSHOT_KEY,
    fileSnapshot: null,
  });
  db.projectUpdate.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type ActionResult = { ok: boolean; status?: number; error?: string };

const PATHS = [
  ['restoreCheckpoint', () => restoreCheckpoint(PROJECT, CHECKPOINT)],
  ['previewCheckpoint', () => previewCheckpoint(PROJECT, CHECKPOINT)],
  ['exitCheckpointPreview', () => exitCheckpointPreview(PROJECT)],
] as const;

describe('a storage failure is not reported as a pruned checkpoint', () => {
  for (const [name, call] of PATHS) {
    it(`${name} answers 503 and says nothing was changed`, async () => {
      sdk.send.mockRejectedValue(accessDenied());

      const result: ActionResult = await call();

      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/try again/i);
      expect(result.error).not.toMatch(/cannot restore/i);
      // Nothing may be written from a snapshot we could not read.
      expect(db.projectUpdate).not.toHaveBeenCalled();
    });
  }
});

describe('a genuinely pruned checkpoint still says so', () => {
  for (const [name, call] of PATHS) {
    it(`${name} keeps the 409 when the snapshot really is gone`, async () => {
      sdk.send.mockRejectedValue(absentKey());

      const result: ActionResult = await call();

      expect(result.ok).toBe(false);
      // Control for the block above: if 503 had simply replaced 409 everywhere, this
      // would fail and the distinction would be fake.
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/cannot restore/i);
      expect(db.projectUpdate).not.toHaveBeenCalled();
    });
  }

  it('previewCheckpoint writes the files when storage answers', async () => {
    // Proof the 503 and 409 cases are not passing because the path is broken outright.
    sdk.send.mockResolvedValue(snapshotBody());

    const result: ActionResult = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result.ok).toBe(true);
    expect(db.projectUpdate).toHaveBeenCalledTimes(1);
    const written = db.projectUpdate.mock.calls[0]?.[0]?.data?.lastCode as string;
    expect(written).toContain('<file path=');
  });
});

describe('collectExportFiles', () => {
  const checkpoints = [
    {
      id: CHECKPOINT,
      snapshotKey: SNAPSHOT_KEY,
      fileSnapshot: null,
      createdAt: new Date('2026-08-18T02:00:00.000Z'),
    },
  ];

  it('throws rather than handing back an empty ZIP', async () => {
    sdk.send.mockRejectedValue(accessDenied());
    await expect(collectExportFiles({ projectId: PROJECT, checkpoints })).rejects.toThrow(
      /storage/i,
    );
  });

  it('returns the files when storage answers', async () => {
    sdk.send.mockResolvedValue(snapshotBody());
    const { files, oversized } = await collectExportFiles({ projectId: PROJECT, checkpoints });
    expect(files.map((file) => file.path)).toEqual(['src/App.jsx']);
    expect(oversized).toEqual([]);
  });

  it('returns nothing when the snapshot is genuinely gone', async () => {
    // The route turns this into 409 "No checkpoint files to export", which is honest.
    sdk.send.mockRejectedValue(absentKey());
    const { files } = await collectExportFiles({ projectId: PROJECT, checkpoints });
    expect(files).toEqual([]);
  });
});
