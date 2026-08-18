import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The test that protects a user's work.
 *
 * A cold sandbox boot restores the latest checkpoint. If that snapshot cannot be read,
 * `loadRestoreFiles` must NOT fall through to `captureFileSnapshot`, which reads
 * `Project.lastCode` — a field that lags the sandbox. The old code did exactly that,
 * because a failed `get` came back as `null`, `readSnapshot` turned it into `[]`, and
 * `[]` is indistinguishable from an empty checkpoint. The sandbox then booted a stale
 * tree, generation continued from it, and the *next* checkpoint was written from that
 * stale tree — so the user's recent work was rolled back and then re-committed as
 * current, with nothing logged. The user sees changes disappear and cannot say when.
 *
 * The distinction has to stay real in both directions, so absence is tested too: a
 * genuinely empty checkpoint must still fall back to `lastCode`, or first generation and
 * every legacy project would stop booting.
 *
 * Prisma and the S3 transport are stubbed; no database and no socket are involved.
 *
 * Goes red if: the fallback is reachable from a failed read again (the "never looked at
 * lastCode" and rejection expectations fail); the fallback stops working for a genuinely
 * absent snapshot (the absence case fails); or a boot that dies on the snapshot read
 * stops marking the project FAILED, which is what strands the row in BOOTING so every
 * later request waits ninety seconds on a boot that is already dead.
 */

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
const db = vi.hoisted(() => ({
  checkpointFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class StubbedS3Client {
      readonly send = sdk.send;
    },
  };
});

vi.mock('@/lib/db', () => {
  const tx = {
    $executeRaw: db.executeRaw,
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
  };
  return {
    prisma: {
      checkpoint: { findFirst: db.checkpointFindFirst },
      project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
      $queryRaw: db.queryRaw,
      $executeRaw: db.executeRaw,
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

/** Reads AppSetting and provider rows; nothing this test is about. */
vi.mock('@/lib/sandbox/migrate-env', () => ({ migrateEnvSandboxProvider: async () => undefined }));

const { NoSuchKey, S3ServiceException } = await import('@aws-sdk/client-s3');
const { captureFileSnapshot, SnapshotReadError } = await import('@/lib/checkpoints/snapshot.ts');
const { ensureSandbox, loadRestoreFiles, SandboxBootError } = await import(
  '@/lib/sandbox/manager.ts'
);

const PROJECT = 'proj_restore_probe';
const SNAPSHOT_KEY = 'snapshots/proj_restore_probe/cp_latest.json.gz';

/** What the sandbox had at the last checkpoint: the user's current work. */
const CURRENT = [
  { path: 'src/App.jsx', content: 'export default function App(){return <h1>Third revision</h1>}' },
  { path: 'src/Pricing.jsx', content: 'export default function Pricing(){return <section/>}' },
];

/** What `Project.lastCode` still holds: an older tree. */
const STALE_LAST_CODE =
  '<file path="src/App.jsx">export default function App(){return <h1>First revision</h1>}</file>';

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
  db.checkpointFindFirst.mockReset();
  db.projectFindFirst.mockReset();
  db.projectUpdate.mockReset();
  db.queryRaw.mockReset();
  db.executeRaw.mockReset();

  db.checkpointFindFirst.mockResolvedValue({ snapshotKey: SNAPSHOT_KEY, fileSnapshot: null });
  db.projectFindFirst.mockResolvedValue({
    id: PROJECT,
    stack: 'NEXTJS',
    sandboxId: null,
    previewUrl: null,
    sandboxStatus: 'NONE',
    previewMode: 'STATIC',
    activeJobId: null,
    sandboxStartedAt: null,
    lastCode: STALE_LAST_CODE,
  });
  db.projectUpdate.mockResolvedValue({});
  db.queryRaw.mockResolvedValue([]);
  db.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('loadRestoreFiles', () => {
  it('restores the checkpoint when storage answers', async () => {
    sdk.send.mockResolvedValue({
      Body: {
        transformToByteArray: async () =>
          new Uint8Array(gzipSync(Buffer.from(JSON.stringify(CURRENT), 'utf8'))),
      },
    });

    const files = await loadRestoreFiles(PROJECT);
    expect(files.map((file) => file.path)).toEqual(['src/App.jsx', 'src/Pricing.jsx']);
    expect(files[0]?.content).toContain('Third revision');
  });

  it('refuses to boot from lastCode when the snapshot read failed', async () => {
    sdk.send.mockRejectedValue(accessDenied());

    await expect(loadRestoreFiles(PROJECT)).rejects.toBeInstanceOf(SnapshotReadError);

    // The decisive assertion: it never even asked for the project row, so it cannot have
    // reached `lastCode`. Before the fix this call happened and its stale tree was
    // written into the fresh sandbox.
    expect(db.projectFindFirst).not.toHaveBeenCalled();
  });

  it('control: the stale fallback was available and non-empty the whole time', async () => {
    // Without this the previous test could pass for the wrong reason — a fallback that
    // returns nothing is not a fallback anyone would notice.
    const fallback = await captureFileSnapshot(PROJECT);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.content).toContain('First revision');
    expect(fallback[0]?.content).not.toContain('Third revision');
    expect(db.projectFindFirst).toHaveBeenCalled();
  });

  it('still falls back to lastCode when the checkpoint is genuinely empty', async () => {
    sdk.send.mockRejectedValue(absentKey());

    const files = await loadRestoreFiles(PROJECT);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain('First revision');
    expect(db.projectFindFirst).toHaveBeenCalled();
  });

  it('falls back to lastCode when the project has no checkpoint at all', async () => {
    db.checkpointFindFirst.mockResolvedValue(null);

    const files = await loadRestoreFiles(PROJECT);
    expect(files).toHaveLength(1);
    expect(sdk.send).not.toHaveBeenCalled();
  });
});

describe('a boot that cannot read the snapshot', () => {
  it('fails visibly at the checkpoint step and marks the project FAILED', async () => {
    sdk.send.mockRejectedValue(accessDenied());

    const error = await ensureSandbox(PROJECT).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.step).toBe('checkpoint');
    // Not NO_CHECKPOINT: the routes map that to 409 "generate the project first", which
    // is a different situation with a different next move for the user.
    expect(error.code).toBe('BOOT_FAILED');
    expect(error.message).toMatch(/storage/i);

    // A raw throw here would escape before the boot's own catch, leaving the row on
    // BOOTING from claimBoot — and every later request would then wait out the 90s
    // ready poll on a boot that is already dead.
    const statuses = db.projectUpdate.mock.calls.map(
      (call) => (call[0] as { data?: { sandboxStatus?: string } }).data?.sandboxStatus,
    );
    expect(statuses).toContain('FAILED');
    expect(statuses.at(-1)).toBe('FAILED');
  });

  it('never wrote the stale tree into a sandbox', async () => {
    sdk.send.mockRejectedValue(accessDenied());
    await expect(ensureSandbox(PROJECT)).rejects.toBeInstanceOf(SandboxBootError);
    // captureFileSnapshot is the only reader of lastCode on this path.
    expect(db.projectFindFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ select: { lastCode: true } }),
    );
  });
});

describe('ensureSandbox reaches the boot at all', () => {
  /**
   * Found while writing the tests above: both of them timed out at sixty seconds because
   * `ensureSandbox` never got as far as `bootProject`. It registers its own promise in
   * the `inflight` map in the same synchronous block that starts it, then the first thing
   * the body does after an `await` is ask that map whether a boot is already running —
   * and finds itself. Returning that promise from an `async` function makes it adopt it,
   * so the boot waits on its own completion and never settles. Nothing throws, nothing
   * logs, the request just hangs.
   *
   * Goes red if the self-match guard in `waitForInflightOrReady` is removed: this suite
   * stops finishing rather than reporting a failure, which is the signature of the bug.
   */
  it('settles instead of waiting on its own promise', async () => {
    sdk.send.mockRejectedValue(accessDenied());

    const settled = await Promise.race([
      ensureSandbox(PROJECT).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('never settled'), 2_000)),
    ]);

    expect(settled).toBe('rejected');
    // Proof it actually ran the boot rather than short-circuiting somewhere earlier.
    expect(db.checkpointFindFirst).toHaveBeenCalled();
  });

  it('control: adopting the inflight entry unconditionally hangs forever', async () => {
    // The shape that was in `ensureSandbox`, isolated, so the guard above cannot be
    // dropped as an unnecessary check. The indirection matters: returning the promise
    // straight out of itself makes V8 raise "Chaining cycle detected", but routed through
    // a helper and a `.finally` — as it is in the real function — nothing is raised and
    // the boot simply never settles. That is why this cost sixty seconds to notice.
    const inflight = new Map<string, Promise<string>>();

    async function waitForInflight(): Promise<string | null> {
      const existing = inflight.get('p');
      if (existing) return existing;
      return null;
    }

    const start = () => {
      const run = (async () => {
        await Promise.resolve();
        const waited = await waitForInflight();
        if (waited) return waited;
        return 'booted';
      })().finally(() => {
        if (inflight.get('p') === run) inflight.delete('p');
      });
      inflight.set('p', run);
      return run;
    };

    const outcome = await Promise.race([
      start().catch(() => 'threw'),
      new Promise<string>((resolve) => setTimeout(() => resolve('never settled'), 250)),
    ]);
    expect(outcome).toBe('never settled');
  });

  it('a second caller still shares the first boot', async () => {
    sdk.send.mockRejectedValue(accessDenied());

    // Coalescing is the reason the map exists, so the guard must not disable it.
    const first = ensureSandbox(PROJECT);
    const second = ensureSandbox(PROJECT);
    const [a, b] = await Promise.all([first.catch((error: unknown) => error), second.catch((error: unknown) => error)]);
    expect(a).toBeInstanceOf(SandboxBootError);
    expect(b).toBe(a);
    expect(db.checkpointFindFirst).toHaveBeenCalledTimes(1);
  });
});
