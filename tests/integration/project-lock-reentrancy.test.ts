import '../setup/env';
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  acquireLock,
  forceRelease,
  holdProjectLock,
  releaseLock,
  renewLock,
  withProjectLock,
} from '@/lib/projects/lock';

/**
 * The re-entrancy contract of `lib/projects/lock.ts`.
 *
 * `acquireLock` is re-entrant for the same user on purpose, and `withProjectLock` used to
 * release in `finally` regardless. Because the checkpoint writes (preview / exit /
 * restore) are owner-gated, the caller there is routinely the same identity whose
 * generation already holds the lock: the action succeeded, wrote `lastCode`, and then
 * released the lock out from under the in-flight generation, whose heartbeat's
 * `renewLock` then answered "Lock is not held" and whose project became acquirable by a
 * concurrent publish writing the same `lastCode` (security review NAV-03).
 *
 * These assertions are about real rows, so they fail if `holdProjectLock` or
 * `withProjectLock` goes back to releasing unconditionally, or if a nested acquire starts
 * re-stamping the outer hold's reason or expiry.
 */

const prisma = testPrismaClient();

const OWNER = 'user_lock_reentry_owner';
const OTHER = 'user_lock_reentry_other';
const WS = 'ws_lock_reentry';
const PROJECT = 'proj_lock_reentry';

type Row = {
  lockedById: string | null;
  lockedAt: Date | null;
  lockExpiresAt: Date | null;
  lockReason: string | null;
};

function lockRow(projectId: string) {
  return prisma.$queryRaw<Row[]>`
    SELECT "lockedById", "lockedAt", "lockExpiresAt", "lockReason"
    FROM "Project" WHERE id = ${projectId}
  `;
}

async function readLock(projectId: string) {
  const row = (await lockRow(projectId))[0];
  return {
    lockedById: row?.lockedById ?? null,
    lockedAt: row?.lockedAt?.getTime() ?? null,
    lockExpiresAt: row?.lockExpiresAt?.getTime() ?? null,
    lockReason: row?.lockReason ?? null,
  };
}

async function seed() {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  for (const [id, email] of [
    [OWNER, 'lock-reentry-owner@example.com'],
    [OTHER, 'lock-reentry-other@example.com'],
  ] as const) {
    await prisma.user.upsert({
      where: { id },
      create: { id, email, name: id, role: 'MEMBER', passwordHash: 'not-a-real-hash' },
      update: {},
    });
  }
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'Re-entrancy', ownerId: OWNER, initialPrompt: 'lock probe' },
    update: {},
  });
}

beforeEach(async () => {
  await seed();
  await prisma.$executeRaw`
    UPDATE "Project"
    SET "lockedById" = NULL, "lockedAt" = NULL, "lockExpiresAt" = NULL, "lockReason" = NULL
    WHERE id = ${PROJECT}
  `;
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [OWNER, OTHER] } } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('acquireLock re-entrancy reporting', () => {
  it('reports a free lock as a fresh take and a live self-hold as re-entry', async () => {
    const first = await acquireLock(PROJECT, OWNER, 'generation');
    expect(first).toEqual({ ok: true, reentered: false });

    const second = await acquireLock(PROJECT, OWNER, 'publish');
    expect(second).toEqual({ ok: true, reentered: true });
  });

  it('leaves the existing hold untouched on re-entry', async () => {
    await acquireLock(PROJECT, OWNER, 'publish');
    const before = await readLock(PROJECT);

    // A different reason and a different TTL: neither may reach the row.
    await acquireLock(PROJECT, OWNER, 'generation', 60);

    expect(await readLock(PROJECT)).toEqual(before);
    expect(before.lockReason).toBe('publish');
  });

  it('treats our own expired hold as a fresh take, not re-entry', async () => {
    await acquireLock(PROJECT, OWNER, 'publish');
    await prisma.$executeRaw`
      UPDATE "Project" SET "lockExpiresAt" = NOW() - INTERVAL '1 minute' WHERE id = ${PROJECT}
    `;

    const retaken = await acquireLock(PROJECT, OWNER, 'generation');
    // Nothing was left to preserve, so this must overwrite reason and expiry.
    expect(retaken).toEqual({ ok: true, reentered: false });
    const row = await readLock(PROJECT);
    expect(row.lockReason).toBe('generation');
    expect(row.lockExpiresAt).toBeGreaterThan(Date.now());
  });

  it('still refuses a lock held live by someone else', async () => {
    await acquireLock(PROJECT, OTHER, 'generation');
    const denied = await acquireLock(PROJECT, OWNER, 'generation');
    expect(denied.ok).toBe(false);
    await releaseLock(PROJECT, OTHER);
  });
});

describe('withProjectLock', () => {
  it('leaves the outer holder’s lock in place when it re-entered', async () => {
    // Stands in for the running generation: it holds the lock and renews it itself.
    await acquireLock(PROJECT, OWNER, 'generation');
    const before = await readLock(PROJECT);

    const inner = await withProjectLock(PROJECT, OWNER, 'generation', async () => {
      // The generation is still the holder while the nested work runs.
      expect((await readLock(PROJECT)).lockedById).toBe(OWNER);
      return 'wrote lastCode';
    });

    expect(inner).toEqual({ ok: true, value: 'wrote lastCode' });
    expect(await readLock(PROJECT)).toEqual(before);
    // The symptom that made this observable: the outer heartbeat kept failing.
    expect(await renewLock(PROJECT, OWNER)).toEqual({ ok: true });

    await releaseLock(PROJECT, OWNER);
  });

  it('releases a lock it took itself', async () => {
    const taken = await withProjectLock(PROJECT, OWNER, 'generation', async () => {
      expect((await readLock(PROJECT)).lockedById).toBe(OWNER);
      return 'done';
    });

    expect(taken).toEqual({ ok: true, value: 'done' });
    expect(await readLock(PROJECT)).toEqual({
      lockedById: null,
      lockedAt: null,
      lockExpiresAt: null,
      lockReason: null,
    });
  });

  it('releases a lock it took itself even when the work throws', async () => {
    await expect(
      withProjectLock(PROJECT, OWNER, 'generation', async () => {
        throw new Error('snapshot write failed');
      }),
    ).rejects.toThrow('snapshot write failed');

    expect((await readLock(PROJECT)).lockedById).toBeNull();
  });

  it('keeps the outer hold even when the nested work throws', async () => {
    await acquireLock(PROJECT, OWNER, 'generation');
    const before = await readLock(PROJECT);

    await expect(
      withProjectLock(PROJECT, OWNER, 'generation', async () => {
        throw new Error('snapshot write failed');
      }),
    ).rejects.toThrow('snapshot write failed');

    expect(await readLock(PROJECT)).toEqual(before);
    await releaseLock(PROJECT, OWNER);
  });

  it('reports the conflict without running the work when someone else holds it', async () => {
    await acquireLock(PROJECT, OTHER, 'publish');
    let ran = false;

    const result = await withProjectLock(PROJECT, OWNER, 'generation', async () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.heldBy.id).toBe(OTHER);
    // The other user's lock survived the refusal.
    expect((await readLock(PROJECT)).lockedById).toBe(OTHER);
    await releaseLock(PROJECT, OTHER);
  });
});

describe('holdProjectLock', () => {
  it('takes a free lock, heartbeats it, and hands it back on release', async () => {
    const hold = await holdProjectLock(PROJECT, OWNER, 'publish');
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    expect(hold.reentered).toBe(false);
    expect((await readLock(PROJECT)).lockedById).toBe(OWNER);

    await hold.release();
    expect(await readLock(PROJECT)).toEqual({
      lockedById: null,
      lockedAt: null,
      lockExpiresAt: null,
      lockReason: null,
    });
  });

  /**
   * The class NAV-03 belongs to: a scope that re-entered someone else's live hold must not
   * be able to give that lock away, however its own cleanup is written.
   */
  it('releases nothing when it re-entered a live hold', async () => {
    await acquireLock(PROJECT, OWNER, 'generation');
    const before = await readLock(PROJECT);

    const hold = await holdProjectLock(PROJECT, OWNER, 'publish');
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    expect(hold.reentered).toBe(true);
    await hold.release();

    // Reason, lockedAt and expiry all survive, and the original holder can still renew.
    expect(await readLock(PROJECT)).toEqual(before);
    expect(before.lockReason).toBe('generation');
    expect(await renewLock(PROJECT, OWNER)).toEqual({ ok: true });

    await releaseLock(PROJECT, OWNER);
  });

  it('is idempotent, so a second release cannot free the next holder’s lock', async () => {
    const hold = await holdProjectLock(PROJECT, OWNER, 'generation');
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    await hold.release();
    await acquireLock(PROJECT, OTHER, 'publish');

    await hold.release();

    expect((await readLock(PROJECT)).lockedById).toBe(OTHER);
    await releaseLock(PROJECT, OTHER);
  });

  it('reports the holder without taking anything when someone else holds it', async () => {
    await acquireLock(PROJECT, OTHER, 'generation');

    const hold = await holdProjectLock(PROJECT, OWNER, 'publish');
    expect(hold.ok).toBe(false);
    if (hold.ok) return;

    expect(hold.heldBy.id).toBe(OTHER);
    expect((await readLock(PROJECT)).lockedById).toBe(OTHER);
    await releaseLock(PROJECT, OTHER);
  });
});

/**
 * The guard that keeps NAV-03 closed. `holdProjectLock` only helps if new code reaches for
 * it instead of re-deriving the `acquireLock` + `beginLockHeartbeat` + `releaseLock` triple
 * that all six holders originally got wrong, and nothing in the type system says "do not
 * pair these three by hand". So this is asserted against the source.
 *
 * `lib/projects/lock.ts` owns the primitives. `lib/jobs/lifecycle.ts` is the one
 * legitimate exception: it acquires when a job starts and releases when the job settles,
 * keyed on `job.userId` — a pairing across two functions in a job's lifetime, not a scope
 * that could hand back a hold it re-entered.
 */
const PRIMITIVE_OWNERS: Record<string, true> = {
  'lib/projects/lock.ts': true,
  'lib/jobs/lifecycle.ts': true,
};
const PRIMITIVES = /\b(?:acquireLock|beginLockHeartbeat|releaseLock)\b/;
const LOCK_IMPORT = /import\s*\{[^}]*\}\s*from\s*'@\/lib\/projects\/lock'/g;

function sourceFiles(root: string) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => `${root}/${entry.split(sep).join('/')}`);
}

describe('the lock primitives stay behind holdProjectLock', () => {
  it('has no call site pairing acquire, heartbeat and release by hand', () => {
    const offenders = [...sourceFiles('app'), ...sourceFiles('lib')].filter((file) => {
      if (PRIMITIVE_OWNERS[file]) return false;
      const imported = readFileSync(file, 'utf8').match(LOCK_IMPORT) ?? [];
      return imported.some((statement) => PRIMITIVES.test(statement));
    });

    expect(offenders).toEqual([]);
  });

  /**
   * Every scope that holds the lock across async work. `lib/checkpoints/actions.ts` is
   * absent on purpose: it holds through `withProjectLock`, which is itself built on
   * `holdProjectLock` and is covered by the assertions above.
   */
  it('routes every lock holder through holdProjectLock', () => {
    const holders = [
      'app/api/generate-ai-code-stream/route.ts',
      'app/api/projects/[id]/import/route.ts',
      'app/api/projects/[id]/publish/route.ts',
      'lib/audit/actions.ts',
      'lib/publish/actions.ts',
      'lib/seo/actions.ts',
    ];

    const missing = holders.filter(
      (file) => !readFileSync(file, 'utf8').includes('holdProjectLock('),
    );

    expect(missing).toEqual([]);
  });
});
