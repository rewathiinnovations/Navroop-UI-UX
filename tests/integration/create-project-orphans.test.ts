import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-808 — `createProject` inserts the row, then runs `upsertImportSource`, the plan flow and
 * the template counter outside any transaction. Exactly one failure mode was compensated:
 * `ProviderNotConfiguredError` deleted the row. Every other throw — a provider 429 that
 * exhausted failover, a Zod rejection of the model's plan JSON, a `createOrReuseJob`
 * failure — re-threw with the row already committed, leaving an "Untitled project" corpse in
 * PLANNING with no plan that still counted against the workspace's project ceiling.
 *
 * Wrapping the whole thing in `prisma.$transaction` is not the fix: the plan flow calls the
 * AI provider, and `withLimit` takes a project-limit advisory lock for the insert, so the
 * transaction would serialise every concurrent create in the workspace behind one
 * multi-second generation. The row is compensated instead — for every failure.
 */

const prisma = testPrismaClient();

const OWNER = 'user_create_orphan_owner';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'create-orphan@example.com',
  name: 'Create Orphan Owner',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));
const planFlow = vi.hoisted(() => ({ throws: null as (() => Error) | null }));

/** next-auth cannot load under the node test environment. */
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
}));

vi.mock('@/lib/projects/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects/plan')>();
  return {
    ...actual,
    applyCreateProjectPlanFlow: async () => {
      if (planFlow.throws) throw planFlow.throws();
      return { plan: { id: 'plan-1', version: 1 } };
    },
  };
});

vi.mock('@/lib/plans/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/plans/limits')>();
  return {
    ...actual,
    // The project ceiling counts every row in the shared test database, so it refuses for
    // reasons this suite is not about (F-307 owns the reservation transaction). The
    // reservation still runs in a real transaction so the insert behaves identically.
    // Dynamic import: a hoisted mock factory cannot reach this file's top-level bindings.
    withLimit: async <T>(
      _workspaceId: string,
      _kind: string,
      _upcoming: number,
      create: (tx: unknown) => Promise<T>,
    ) => {
      const { prisma: db } = await import('@/lib/db');
      return { ok: true as const, data: await db.$transaction((tx) => create(tx)) };
    },
  };
});

import { createProject } from '@/lib/projects/actions';
import { NO_PROVIDER_CONFIGURED_MESSAGE, ProviderNotConfiguredError } from '@/lib/ai/providers';

async function ownedProjects() {
  return prisma.project.findMany({
    where: { ownerId: OWNER },
    select: { id: true, name: true, phase: true, deletedAt: true },
  });
}

beforeEach(async () => {
  planFlow.throws = null;
  session.user = OWNER_ACTOR;
  await prisma.user.upsert({
    where: { id: OWNER },
    create: {
      id: OWNER,
      email: OWNER_ACTOR.email,
      name: OWNER_ACTOR.name,
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.deleteMany({ where: { ownerId: OWNER } });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { ownerId: OWNER } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: OWNER } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('a plan failure leaves no orphan project row (F-808)', () => {
  it('compensates a provider failure that is not a configuration error', async () => {
    planFlow.throws = () => new Error('DeepSeek returned 429 after every failover attempt');

    const result = await createProject({ initialPrompt: 'A landing page for a bakery' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(502);
    expect(result.ok === false && result.error).toMatch(/nothing was saved/i);
    // Not soft-deleted-but-counted: gone. `listProjects` filters `deletedAt`, but the
    // project ceiling is a row count.
    expect(await ownedProjects(), 'an orphan project survived the failed plan').toEqual([]);
  });

  it('compensates a rejected plan payload', async () => {
    planFlow.throws = () => new Error('plan JSON failed schema validation');

    const result = await createProject({ initialPrompt: 'A menu site for a cafe' });

    expect(result.ok).toBe(false);
    expect(await ownedProjects()).toEqual([]);
  });

  it('keeps the configuration error its own status and message', async () => {
    planFlow.throws = () =>
      new ProviderNotConfiguredError(NO_PROVIDER_CONFIGURED_MESSAGE, 'deepseek');

    const result = await createProject({ initialPrompt: 'A portfolio site' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(503);
    expect(result.ok === false && result.error).toBe(NO_PROVIDER_CONFIGURED_MESSAGE);
    expect(await ownedProjects()).toEqual([]);
  });

  // Control: the compensation is reached only on failure. Without this the suite would pass
  // against a `createProject` that deleted its row every time.
  it('control: a successful create keeps its project', async () => {
    const result = await createProject({ initialPrompt: 'A landing page for a florist' });

    expect(result.ok).toBe(true);
    const rows = await ownedProjects();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('PLANNING');
  });

  // The deferred path is deliberately different: the browser is already in the workspace,
  // `useProjectPlan` polls, and a failed PLAN job surfaces in the recovery panel with Try
  // again. Deleting the row underneath that user would be the worse failure.
  it('the deferred-plan path keeps its row so the recovery panel has something to fix', async () => {
    planFlow.throws = () => new Error('provider unavailable');

    const result = await createProject({
      initialPrompt: 'A landing page for a bookshop',
      deferPlanning: true,
    });

    expect(result.ok).toBe(true);
    const rows = await ownedProjects();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('PLANNING');
  });
});
