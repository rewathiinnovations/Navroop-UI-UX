/**
 * The client half of the checkpoint authorization fix.
 *
 * `restoreCheckpoint` was the only call that turned a 409 into `emitLockConflict`,
 * which is what raises the LockBar through `useProjectPresence`. Preview, exit and
 * bookmark took no server lock at all, so they could not 409 — that missing lock was
 * the bug. Now that they take it, a conflict on those three is reachable and needs
 * the same banner, so the branch lives in one shared request helper.
 *
 * The 403 sentence is the server's (`forbidden()` in lib/checkpoints/actions.ts);
 * these tests pin that the client relays it verbatim instead of overwriting it with
 * a generic line or leaking the bare status word.
 *
 * Fetch is stubbed. No network, no Prisma, no loopback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_LOCK_EVENT } from '@/lib/projects/lock-client';
import {
  exitCheckpointPreview,
  isLockConflictError,
  previewCheckpoint,
  restoreCheckpoint,
  toggleCheckpointBookmark,
} from '@/lib/checkpoints/client';

const PROJECT = 'p-cp-client';
const CHECKPOINT = 'cp-client';

const FORBIDDEN_SENTENCE = 'This project belongs to someone else';

const LOCK_BODY = {
  error: 'Ada is working on this project',
  code: 'PROJECT_LOCKED',
  heldBy: { name: 'Ada' },
  expiresAt: '2026-08-19T12:00:00.000Z',
};

/** Every checkpoint write, so a call added without the shared helper fails here. */
const WRITES = [
  { name: 'previewCheckpoint', call: () => previewCheckpoint(PROJECT, CHECKPOINT) },
  { name: 'exitCheckpointPreview', call: () => exitCheckpointPreview(PROJECT) },
  { name: 'toggleCheckpointBookmark', call: () => toggleCheckpointBookmark(PROJECT, CHECKPOINT) },
  { name: 'restoreCheckpoint', call: () => restoreCheckpoint(PROJECT, CHECKPOINT) },
] as const;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(body: unknown, status: number) {
  const fetchMock = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * `emitLockConflict` is a no-op without a `window`, and the suite runs on node.
 * A minimal stand-in records the dispatched event so the assertion is on the real
 * emit path rather than on a mocked module.
 */
function captureLockEvents() {
  const seen: { name: string; expiresAt: string }[] = [];
  vi.stubGlobal('window', {
    dispatchEvent: (event: Event) => {
      if (event.type === PROJECT_LOCK_EVENT) {
        seen.push((event as CustomEvent<{ name: string; expiresAt: string }>).detail);
      }
      return true;
    },
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a 409 from any checkpoint write raises the LockBar', () => {
  for (const write of WRITES) {
    it(`${write.name} emits the lock conflict and flags the rejection as locked`, async () => {
      stubFetch(LOCK_BODY, 409);
      const events = captureLockEvents();

      const error = await write.call().then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(events).toEqual([{ name: 'Ada', expiresAt: LOCK_BODY.expiresAt }]);
      expect(isLockConflictError(error)).toBe(true);
      expect((error as Error).message).toBe('Ada is working on this project');
    });
  }

  it('does not flag a 409 that names no lock holder, so a pruned snapshot still reaches chat', async () => {
    stubFetch({ error: 'Old checkpoint — cannot restore' }, 409);
    const events = captureLockEvents();

    const error = await restoreCheckpoint(PROJECT, CHECKPOINT).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(events).toEqual([]);
    expect(isLockConflictError(error)).toBe(false);
    expect((error as Error).message).toBe('Old checkpoint — cannot restore');
  });
});

describe("a 403 reaches the user as the server's sentence, never the status word", () => {
  for (const write of WRITES) {
    it(`${write.name} relays the ownership sentence unmodified`, async () => {
      stubFetch({ error: FORBIDDEN_SENTENCE }, 403);

      const error = await write.call().then(
        () => null,
        (thrown: unknown) => thrown,
      );

      const message = (error as Error).message;
      expect(message).toBe(FORBIDDEN_SENTENCE);
      expect(message).not.toBe('Forbidden');
      expect(message).not.toMatch(/forbidden/i);
      expect(isLockConflictError(error)).toBe(false);
    });
  }
});

describe('the success path is unchanged', () => {
  const ROW = {
    id: CHECKPOINT,
    label: 'Version 3',
    thumbnailUrl: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    isBookmarked: true,
  };

  for (const write of WRITES) {
    it(`${write.name} returns the checkpoint and emits nothing`, async () => {
      stubFetch({ checkpoint: ROW }, 200);
      const events = captureLockEvents();

      await expect(write.call()).resolves.toEqual({
        id: CHECKPOINT,
        label: 'Version 3',
        thumbnailUrl: null,
        createdAt: ROW.createdAt,
        isBookmarked: true,
        snapshotPruned: false,
      });
      expect(events).toEqual([]);
    });
  }
});
