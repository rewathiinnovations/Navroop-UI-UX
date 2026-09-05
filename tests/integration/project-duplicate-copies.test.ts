import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-805 / F-664: "Duplicate" copied the prompt and nothing else.
 *
 * The `select` read five columns and the `create` wrote six, so the copy had no
 * `lastCode` — the site — no `ImportSource`, no plan, and fell to the schema default
 * `PLANNING` phase. It consumed a project slot from the plan limit to produce a shell,
 * and it was the only project-creating action in `lib/projects/actions.ts` that wrote no
 * audit row. There was no test for it at all.
 *
 * These cases pin the product decision: Duplicate copies the *site*. `Project.lastCode`
 * is what `collectPublishFiles` (`lib/publish/files.ts:91`) and `collectExportFiles`
 * (`lib/export/collect.ts:41`) fall back to when a project has no checkpoint, so a
 * duplicate carrying `lastCode` is publishable and exportable — which is why the
 * checkpoint objects are not copied. `ProjectAsset` rows are not copied either: they
 * carry `storageKey`s owned by the source, and duplicating the rows would double-count
 * workspace storage and let either project's purge delete the other's objects.
 */

const prisma = testPrismaClient();

const OWNER = 'user_dup_owner';
const OTHER = 'user_dup_other';
const SOURCE = 'proj_dup_source';
const UNLIMITED_PLAN = 'plan_dup_unlimited';
const WORKSPACE = 'default';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'dup-owner@example.com',
  name: 'Dup Owner',
  role: 'MEMBER',
};
const OTHER_ACTOR: Actor = {
  id: OTHER,
  email: 'dup-other@example.com',
  name: 'Dup Other',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));

/** next-auth cannot load under the node test environment; the session is the gate. */
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
}));

/** Post-gate generation work that `lib/projects/actions.ts` pulls in at module load. */
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => null,
  applyCreateProjectPlanFlow: async () => undefined,
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: async () => null,
}));
vi.mock('@/lib/memory/extract', () => ({
  extractMemoriesAfterGeneration: async () => undefined,
}));
vi.mock('@/lib/signals/collect', () => ({
  maybeSettleFollowups: async () => undefined,
  recordGenerationKept: async () => undefined,
}));

import { duplicateProject } from '@/lib/projects/actions';
import { toLastCode } from '@/lib/projects/last-code';
import { getCurrentProjectFiles } from '@/lib/github/current-files';

const SITE = toLastCode({
  'app/page.tsx': 'export default function Page() {\n  return <main>Duplicated</main>;\n}',
  'app/about/page.tsx': 'export default function About() {\n  return <main>About</main>;\n}',
});

let previousPlanId: string | null = null;
const duplicatedIds: string[] = [];

async function seedActors() {
  for (const actor of [OWNER_ACTOR, OTHER_ACTOR]) {
    await prisma.user.upsert({
      where: { id: actor.id },
      create: {
        id: actor.id,
        email: actor.email,
        name: actor.name,
        role: actor.role,
        passwordHash: 'not-a-real-hash',
      },
      update: {},
    });
  }
}

/**
 * The project ceiling counts every project in the database (`currentForLimit`), so a
 * seeded test database would refuse the duplicate for the wrong reason. The default
 * workspace's plan is restored in `afterAll`.
 */
async function useUnlimitedProjects() {
  await prisma.plan.upsert({
    where: { id: UNLIMITED_PLAN },
    create: {
      id: UNLIMITED_PLAN,
      key: 'dup-unlimited',
      name: 'Duplicate probe',
      isActive: true,
      isDefault: false,
      monthlyCredits: -1,
      maxProjects: -1,
      maxLiveSites: -1,
      maxPreviewSites: -1,
      maxMembers: -1,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(1024 * 1024 * 1024),
      allowCustomDomain: false,
      allowGithubSync: false,
    },
    update: {},
  });
  const workspace = await prisma.workspace.upsert({
    where: { id: WORKSPACE },
    create: { id: WORKSPACE, planId: UNLIMITED_PLAN, storageBytes: 0 },
    update: {},
  });
  if (previousPlanId === null) previousPlanId = workspace.planId ?? '';
  await prisma.workspace.update({ where: { id: WORKSPACE }, data: { planId: UNLIMITED_PLAN } });
}

beforeEach(async () => {
  session.user = OWNER_ACTOR;
  await seedActors();
  await useUnlimitedProjects();
  await prisma.project.deleteMany({ where: { name: { startsWith: 'Duplicate source' } } });
  await prisma.auditLog.deleteMany({ where: { action: 'project.duplicate' } });
  await prisma.project.create({
    data: {
      id: SOURCE,
      name: 'Duplicate source',
      initialPrompt: 'A landing page for a bakery',
      ownerId: OWNER,
      stack: 'NEXTJS',
      designDirection: 'editorial',
      phase: 'COMPLETE',
      status: 'ready',
      generationStatus: 'ready',
      lastCode: SITE,
      style: 'warm',
      model: 'anthropic/claude',
      thumbnailUrl: 'https://cdn.example.com/thumb.png',
      previewUrl: 'https://preview.example.com/source',
    },
  });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [SOURCE, ...duplicatedIds] } } });
  await prisma.auditLog.deleteMany({ where: { action: 'project.duplicate' } });
  await prisma.user.deleteMany({ where: { id: { in: [OWNER, OTHER] } } });
  if (previousPlanId !== null) {
    await prisma.workspace.update({
      where: { id: WORKSPACE },
      data: { planId: previousPlanId === '' ? null : previousPlanId },
    });
  }
  await prisma.plan.deleteMany({ where: { id: UNLIMITED_PLAN } });
  await prisma.$disconnect();
});

async function duplicate() {
  const result = await duplicateProject(SOURCE);
  if (!result.ok) throw new Error(`duplicateProject refused: ${result.error}`);
  duplicatedIds.push(result.data.id);
  return result.data;
}

describe('duplicateProject copies the site (F-805)', () => {
  it('carries the same files into the copy', async () => {
    const copy = await duplicate();

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: copy.id },
      select: { lastCode: true, phase: true, thumbnailUrl: true, style: true, model: true },
    });
    // The same file tree, read through the one parser the product uses.
    expect(getCurrentProjectFiles({ lastCode: row.lastCode })).toEqual(
      getCurrentProjectFiles({ lastCode: SITE }),
    );
    // A copy that has a site is not "in planning" with nothing to approve.
    expect(row.phase).toBe('COMPLETE');
    expect(row.thumbnailUrl).toBe('https://cdn.example.com/thumb.png');
    expect(row.style).toBe('warm');
    expect(row.model).toBe('anthropic/claude');
  });

  it('does not inherit the source project preview host', async () => {
    const copy = await duplicate();
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: copy.id },
      select: { previewUrl: true },
    });
    expect(row.previewUrl).toBeNull();
  });

  it('writes a project.duplicate audit row naming both projects', async () => {
    const copy = await duplicate();

    const rows = await prisma.auditLog.findMany({ where: { action: 'project.duplicate' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(OWNER);
    expect(rows[0].targetId).toBe(copy.id);
    expect(JSON.stringify(rows[0].before ?? {})).toContain(SOURCE);
  });

  it('carries the import source so the copy keeps its source URL', async () => {
    await prisma.importSource.create({
      data: {
        projectId: SOURCE,
        sourceUrl: 'https://bakery.example.com',
        mode: 'clone',
        designTokens: { colors: ['#fff'] },
        sections: [{ kind: 'hero' }],
        capturedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
    });

    const copy = await duplicate();

    const imported = await prisma.importSource.findUnique({ where: { projectId: copy.id } });
    expect(imported).not.toBeNull();
    expect(imported?.sourceUrl).toBe('https://bakery.example.com');
    expect(imported?.mode).toBe('clone');
    expect(imported?.designTokens).toEqual({ colors: ['#fff'] });
  });

  it('carries the plan so a copy in planning has something to approve', async () => {
    await prisma.project.update({
      where: { id: SOURCE },
      data: { phase: 'PLANNING', lastCode: null },
    });
    await prisma.projectPlan.create({
      data: {
        projectId: SOURCE,
        version: 3,
        content: {
          summary: 'Bakery',
          pages: [{ name: 'Home', description: 'Hero' }],
          keyFeatures: ['Menu'],
        },
        status: 'PENDING',
        sourceMessage: 'A landing page for a bakery',
        trigger: 'initial',
      },
    });

    const copy = await duplicate();

    const plans = await prisma.projectPlan.findMany({ where: { projectId: copy.id } });
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('PENDING');
    expect(plans[0].version).toBe(1);
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: copy.id },
      select: { phase: true },
    });
    expect(row.phase).toBe('PLANNING');
  });

  it('still refuses a project the actor may not touch', async () => {
    session.user = OTHER_ACTOR;
    const result = await duplicateProject(SOURCE);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
  });
});
