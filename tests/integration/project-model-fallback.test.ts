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
  recordGenerationKept: async () => undefined,
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

// F-809: the detail read was `include` with no `select`, so it returned every scalar on
// `Project` while `listProjects` beside it curated ten columns. Any signed-in member could
// read another member's lock holder, lock expiry, `previewUrl` and `progressMessage`, and
// every column added to the model published itself here.
describe('the detail read serves a curated row, not every column', () => {
  const OPERATIONAL_FIELDS = [
    'lockedById',
    'lockedAt',
    'lockExpiresAt',
    'lockReason',
    'previewUrl',
    'progressMessage',
    'generationStatus',
    'contentVersion',
    'activeJobId',
    'activePreviewBuildId',
    'githubRepoFullName',
    'githubRepoUrl',
    'lastPushedAt',
    'deletedAt',
    'initialPrompt',
  ] as const;

  beforeEach(async () => {
    // Real values in every column the read must not publish, so absence is proof the
    // select excludes them rather than proof the row happened to be empty.
    await prisma.project.update({
      where: { id: OFFERED },
      data: {
        lockedById: OWNER,
        lockedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + 60_000),
        lockReason: 'generate',
        previewUrl: 'https://preview.example/offered',
        progressMessage: 'Writing src/App.jsx',
        generationStatus: 'active',
        githubRepoFullName: 'deploy-org/offered',
      },
    });
    // An import row too: `importSource: true` returned its whole row, including the
    // captured `designTokens`/`sections` payloads the workspace never reads.
    await prisma.importSource.upsert({
      where: { projectId: OFFERED },
      create: {
        projectId: OFFERED,
        sourceUrl: 'https://source.example/offered',
        mode: 'clone',
        designTokens: { colors: ['#123456'] },
        sections: [{ kind: 'hero' }],
        capturedAt: new Date(),
      },
      update: { sourceUrl: 'https://source.example/offered', mode: 'clone' },
    });
  });

  it('withholds the lock and operational columns', async () => {
    const stored = await prisma.project.findUniqueOrThrow({
      where: { id: OFFERED },
      select: { lockedById: true, previewUrl: true, progressMessage: true },
    });
    // Control: the columns really are populated, so the assertions below mean something.
    expect(stored.lockedById).toBe(OWNER);
    expect(stored.previewUrl).toBe('https://preview.example/offered');

    const result = await getProject(OFFERED);
    if (!result.ok || !result.data) throw new Error('getProject refused the fixture');
    const served = Object.keys(result.data);
    for (const field of OPERATIONAL_FIELDS) {
      expect(served, `${field} is still served to every member`).not.toContain(field);
    }
  });

  it('still serves everything the workspace and the plan poller read', async () => {
    const result = await getProject(OFFERED);
    if (!result.ok || !result.data) throw new Error('getProject refused the fixture');
    // GenerationWorkspace :346-366 and useProjectPlan's phase poll.
    for (const field of ['id', 'name', 'phase', 'style', 'model', 'lastCode', 'updatedAt']) {
      expect(Object.keys(result.data), `${field} is no longer served`).toContain(field);
    }
    expect(result.data.owner).toBeTruthy();
    // `importSource` is narrowed to the two fields the workspace resumes from.
    const importKeys = Object.keys(result.data.importSource ?? {});
    expect(importKeys.sort()).toEqual(['mode', 'sourceUrl']);
  });
});
