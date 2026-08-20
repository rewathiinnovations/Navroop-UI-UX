import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-004: a stored `Project.model` silently overrode the admin-configured model forever.
 *
 * The workspace seeds its model state from the project row on mount
 * (`GenerationWorkspace.tsx:336`) and then sends that value as `model` on every
 * generation. A requested model is pushed to the FRONT of the provider chain, so the
 * value on the row outranked `ai.primaryModel` from Admin → Configuration for the life
 * of that project — and `readGenerationInput` accepted `model` as an unvalidated
 * `string | null`, so the row could hold a legacy id from before DeepSeek was the only
 * provider. That is the failure mode `.cursor/lessons-learned.md` records for
 * 2026-08-18: a "default" that participates in *ranking* is not a default, it is an
 * override.
 *
 * The fix treats the row as a preference that has to keep validating. `getProject` is
 * where it is decided, because that is the read every consumer goes through — including
 * the one that feeds the client. Real rows, because the point is the round trip: what
 * the column holds versus what the workspace is handed.
 */

const prisma = testPrismaClient();

const OWNER = 'user_model_owner';
const STALE = 'proj_model_stale';
const OFFERED = 'proj_model_offered';
const EMPTY = 'proj_model_empty';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'model-owner@example.com',
  name: 'Model Owner',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));

/** next-auth cannot load under the node test environment. */
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
  countVisualEditsFromSource: () => 0,
  recordVisualEditRate: async () => undefined,
  maybeSettleFollowups: async () => undefined,
}));

import { getProject } from '@/lib/projects/actions';
import { DEFAULT_DEEPSEEK_MODEL, resolveModel } from '@/lib/ai/providers';

/** The one field under test, as the workspace would read it. */
async function servedModel(id: string) {
  const result = await getProject(id);
  if (!result.ok) throw new Error(`getProject refused: ${result.error}`);
  if (!result.data) throw new Error(`getProject found no project ${id}`);
  return result.data.model;
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    create: {
      id: OWNER,
      email: OWNER_ACTOR.email,
      name: OWNER_ACTOR.name,
      role: OWNER_ACTOR.role,
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  // A legacy id from the four-vendor era, a currently offered id, and no choice at all.
  const rows: Array<[string, string | null]> = [
    [STALE, 'gemini-1.5-pro'],
    [OFFERED, 'deepseek-v4-pro'],
    [EMPTY, null],
  ];
  for (const [id, model] of rows) {
    await prisma.project.upsert({
      where: { id },
      create: {
        id,
        name: `Model fixture ${id}`,
        ownerId: OWNER,
        initialPrompt: 'a site whose model preference is under test',
        model,
      },
      update: { deletedAt: null, ownerId: OWNER, model },
    });
  }
  session.user = OWNER_ACTOR;
});

afterAll(async () => {
  await prisma.project
    .deleteMany({ where: { id: { in: [STALE, OFFERED, EMPTY] } } })
    .catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: OWNER } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('a stored model that is no longer offered stops outranking the admin config', () => {
  it('is not served to the workspace, so it is never sent back as an explicit model', async () => {
    // The column still holds it — this is a read-side decision, not a migration.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: STALE },
      select: { model: true },
    });
    expect(row.model).toBe('gemini-1.5-pro');

    expect(await servedModel(STALE)).toBeNull();
  });

  it('leaves the configured primary leading once the stale value is gone', async () => {
    const requested = (await servedModel(STALE)) ?? undefined;
    // Same shape as the generate route: the served value becomes `requestedModel`.
    expect(resolveModel({ AI_PRIMARY_MODEL: 'deepseek-v4-flash' }, requested)).toBe(
      'deepseek-v4-flash',
    );
    expect(resolveModel({}, requested)).toBe(DEFAULT_DEEPSEEK_MODEL);
  });

  it('would have forwarded the stale id if it were still served', () => {
    // The counterfactual, so this suite fails if the read-side drop is removed: a stale
    // id reaching `resolveModel` as an explicit request is now refused outright, which
    // is exactly why it must not be served.
    expect(() => resolveModel({ AI_PRIMARY_MODEL: 'deepseek-v4-flash' }, 'gemini-1.5-pro')).toThrow(
      /gemini-1\.5-pro/,
    );
  });
});

describe('an offered model stays a real preference', () => {
  it('is served unchanged and still outranks a different configured primary', async () => {
    expect(await servedModel(OFFERED)).toBe('deepseek-v4-pro');

    const requested = (await servedModel(OFFERED)) ?? undefined;
    expect(resolveModel({ AI_PRIMARY_MODEL: 'deepseek-v4-flash' }, requested)).toBe(
      'deepseek-v4-pro',
    );
  });

  it('serves null when the project never chose one', async () => {
    expect(await servedModel(EMPTY)).toBeNull();
  });
});
