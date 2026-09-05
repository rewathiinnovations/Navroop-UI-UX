import '../setup/env';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-402: "Starred projects" shipped as a read-only feature.
 *
 * The sidebar had a **Starred** entry, `/projects?starred=true` filtered server-side,
 * the list payload carried `starred`, and the empty state told the user to
 * *"Star a project from its card menu"* — but the card menu was Open / Rename /
 * Duplicate / Delete, and `toggleStar` had no caller anywhere in the repository. A
 * navigation entry that could never show anything, plus copy naming a control that
 * did not exist.
 *
 * `toggleStar` also let any signed-in member write a `ProjectStar` row against any
 * project id, unlike every other project mutation in `lib/projects/*`, which gate on
 * `canMutate` (owner or ADMIN). Starring is per user — the row is keyed
 * `(userId, projectId)` — so these cases pin both halves: the gate matches its
 * siblings, and one user's star never becomes another user's.
 *
 * Real rows, because the point is the round trip: the toggle writes, and the same
 * `starred: true` query the page issues reads it back.
 */

const prisma = testPrismaClient();

const OWNER = 'user_star_owner';
const OTHER = 'user_star_other';
const ADMIN = 'user_star_admin';
const PROJECT = 'proj_star_target';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'star-owner@example.com',
  name: 'Star Owner',
  role: 'MEMBER',
};
const OTHER_ACTOR: Actor = {
  id: OTHER,
  email: 'star-other@example.com',
  name: 'Star Other',
  role: 'MEMBER',
};
const ADMIN_ACTOR: Actor = {
  id: ADMIN,
  email: 'star-admin@example.com',
  name: 'Star Admin',
  role: 'ADMIN',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));

/** next-auth cannot load under the node test environment; the session is the gate under test. */
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

import { listProjects } from '@/lib/projects/actions';
import { toggleStar } from '@/lib/projects/stars';

/** The exact query `/projects?starred=true` issues. */
async function starredProjectIds() {
  const result = await listProjects({ starred: true });
  if (!result.ok) throw new Error(`listProjects refused: ${result.error}`);
  return result.data.projects.map((project) => project.id);
}

async function starRowUserIds() {
  const rows = await prisma.projectStar.findMany({
    where: { projectId: PROJECT },
    select: { userId: true },
  });
  return rows.map((row) => row.userId).sort();
}

beforeEach(async () => {
  for (const actor of [OWNER_ACTOR, OTHER_ACTOR, ADMIN_ACTOR]) {
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
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: {
      id: PROJECT,
      name: 'Star target',
      ownerId: OWNER,
      initialPrompt: 'a landing page worth starring',
    },
    update: { deletedAt: null, ownerId: OWNER },
  });
  await prisma.projectStar.deleteMany({ where: { projectId: PROJECT } });
  session.user = null;
});

afterAll(async () => {
  await prisma.projectStar.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [OWNER, OTHER, ADMIN] } } })
    .catch(() => undefined);
  await prisma.$disconnect();
});

describe('toggleStar round trip', () => {
  it('stars the project for the owner, and the starred list returns it', async () => {
    session.user = OWNER_ACTOR;

    expect(await starredProjectIds()).not.toContain(PROJECT);

    const starred = await toggleStar(PROJECT);
    expect(starred).toEqual({ ok: true, data: { starred: true } });

    expect(await starRowUserIds()).toEqual([OWNER]);
    expect(await starredProjectIds()).toContain(PROJECT);
  });

  it('reports the row it wrote as starred on the unfiltered list too', async () => {
    session.user = OWNER_ACTOR;
    await toggleStar(PROJECT);

    const result = await listProjects({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.projects.find((project) => project.id === PROJECT);
    expect(row?.starred).toBe(true);
  });

  it('unstars on the second toggle and the starred list drops it', async () => {
    session.user = OWNER_ACTOR;
    await toggleStar(PROJECT);

    const unstarred = await toggleStar(PROJECT);
    expect(unstarred).toEqual({ ok: true, data: { starred: false } });

    expect(await starRowUserIds()).toEqual([]);
    expect(await starredProjectIds()).not.toContain(PROJECT);
  });
});

describe('toggleStar authorization', () => {
  it('refuses an unauthenticated caller with 401, before writing a row', async () => {
    session.user = null;

    expect(await toggleStar(PROJECT)).toMatchObject({ ok: false, status: 401 });
    expect(await starRowUserIds()).toEqual([]);
  });

  it('refuses a signed-in member who does not own the project with 403', async () => {
    session.user = OTHER_ACTOR;

    expect(await toggleStar(PROJECT)).toMatchObject({ ok: false, status: 403 });
    // The gate has to fire before the write: a refused call that still starred the
    // project is the bug, not the status code.
    expect(await starRowUserIds()).toEqual([]);
  });

  it('lets an ADMIN who does not own the project star it, as canMutate allows', async () => {
    session.user = ADMIN_ACTOR;

    expect(await toggleStar(PROJECT)).toEqual({ ok: true, data: { starred: true } });
    expect(await starRowUserIds()).toEqual([ADMIN]);
  });

  it('answers 404 for a project that does not exist', async () => {
    session.user = OWNER_ACTOR;

    expect(await toggleStar('proj_star_absent')).toMatchObject({ ok: false, status: 404 });
  });

  it('answers 404 for a soft-deleted project', async () => {
    session.user = OWNER_ACTOR;
    await prisma.project.update({ where: { id: PROJECT }, data: { deletedAt: new Date() } });

    expect(await toggleStar(PROJECT)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('stars are per user', () => {
  it('does not show the admin’s star on the owner’s starred list', async () => {
    session.user = ADMIN_ACTOR;
    await toggleStar(PROJECT);
    expect(await starredProjectIds()).toContain(PROJECT);

    session.user = OWNER_ACTOR;
    expect(await starredProjectIds()).not.toContain(PROJECT);
  });
});

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The half of F-402 that no round-trip assertion can catch: the action worked, and
 * nothing called it. Asserted against the source because "a control exists in the
 * card menu" is not something the type system can state.
 */
describe('the card menu the empty state points at', () => {
  it('wires a star control to toggleStar', () => {
    const card = readFileSync(path.join(repoRoot, 'components/dashboard/ProjectCard.tsx'), 'utf8');

    expect(card).toContain("from '@/lib/projects/stars'");
    expect(card).toContain('toggleStar');
    // The menu item itself, not just the import.
    expect(card).toMatch(/Unstar|Star/);
  });

  it('keeps the empty-state copy pointing at a control that exists', () => {
    const page = readFileSync(path.join(repoRoot, 'app/(app)/projects/page.tsx'), 'utf8');

    // If this sentence is ever reworded, the card menu is what it must keep naming.
    expect(page).toContain('Star a project from its card menu');
    expect(page).toContain('onStarred');
  });
});
