import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-102 end to end, on real Postgres: previewing an old version must not become that version.
 *
 * The bug was a data-loss bug, so the proof has to be about the data. `previewCheckpoint`
 * wrote the selected snapshot into `Project.lastCode` — the row publish, ZIP export, the
 * preview and the next generation all read — and recorded "this is only a preview" in a
 * `useState`. Reload, and the marker was gone while the rollback stayed. This suite walks the
 * whole sequence a user walks (preview, reload, look, leave) against a live database and a
 * live project lock, and asserts `lastCode` is byte-identical at every step.
 *
 * Snapshots are seeded on the legacy `Checkpoint.fileSnapshot` column, which `readSnapshot`
 * still reads. That keeps object storage out of the test — the local storage driver writes
 * under `public/uploads`, which the repo-write guard fails the run for — without stubbing the
 * snapshot reader, so the real read path runs.
 */

const OWNER = { id: 'user_preview_e2e', email: 'preview-e2e@example.com', role: 'MEMBER' };

vi.mock('@/lib/projects/plan', () => ({ peekActor: () => OWNER }));
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => OWNER }));
vi.mock('@/lib/generation/conversation-state', () => ({ peekConversationState: () => null }));

const prisma = testPrismaClient();

const { previewCheckpoint, exitCheckpointPreview, getCheckpoints } =
  await import('@/lib/checkpoints/actions');
const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');

const PROJECT = 'proj_preview_e2e';
const CP_V1 = 'cp_preview_e2e_v1';
const CP_V2 = 'cp_preview_e2e_v2';

const V1 = [{ path: 'app/page.tsx', content: 'export default () => <h1>v1</h1>;' }];
const V2 = [{ path: 'app/page.tsx', content: 'export default () => <h1>v2 — the live site</h1>;' }];

const LIVE_LAST_CODE = `<file path="app/page.tsx">\n${V2[0].content}\n</file>`;

async function liveLastCode() {
  const rows = await prisma.$queryRaw<Array<{ lastCode: string | null }>>`
    SELECT "lastCode" FROM "Project" WHERE id = ${PROJECT}
  `;
  return rows[0]?.lastCode ?? null;
}

async function previewingId() {
  const rows = await prisma.$queryRaw<Array<{ previewingCheckpointId: string | null }>>`
    SELECT "previewingCheckpointId" FROM "Project" WHERE id = ${PROJECT}
  `;
  return rows[0]?.previewingCheckpointId ?? null;
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: OWNER.id },
    create: {
      id: OWNER.id,
      email: OWNER.email,
      name: 'Preview e2e',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.checkpoint.deleteMany({ where: { projectId: PROJECT } });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.project.create({
    data: {
      id: PROJECT,
      name: 'Preview e2e',
      ownerId: OWNER.id,
      initialPrompt: 'A landing page',
      lastCode: LIVE_LAST_CODE,
    },
  });
  for (const [id, files, createdAt] of [
    [CP_V1, V1, new Date('2026-08-18T01:00:00.000Z')],
    [CP_V2, V2, new Date('2026-08-18T02:00:00.000Z')],
  ] as const) {
    await prisma.checkpoint.create({
      data: {
        id,
        projectId: PROJECT,
        label: id === CP_V1 ? 'First build' : 'Latest generation',
        trigger: id === CP_V1 ? 'initial' : 'followup',
        createdAt,
        fileSnapshot: files,
      },
    });
  }
});

afterAll(async () => {
  await prisma.checkpoint.deleteMany({ where: { projectId: PROJECT } });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.user.deleteMany({ where: { id: OWNER.id } });
  await prisma.$disconnect();
});

describe('previewing an older version', () => {
  it('shows v1 while the project stays on v2, and survives a reload', async () => {
    expect(await liveLastCode()).toBe(LIVE_LAST_CODE);

    const preview = await previewCheckpoint(PROJECT, CP_V1);
    expect(preview.ok).toBe(true);

    // The finding, against the real row: 55KB of somebody's site used to be replaced here.
    expect(await liveLastCode()).toBe(LIVE_LAST_CODE);
    expect(await previewingId()).toBe(CP_V1);

    // What the Code tab and the preview pane are served.
    const served = await servedProjectFiles({ id: PROJECT, lastCode: await liveLastCode() });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.files['app/page.tsx']).toBe(V1[0].content);
    expect(served.previewing).toMatchObject({ checkpointId: CP_V1, label: 'First build' });

    // The reload. Every client-side value is gone; the workspace rebuilds from these two
    // calls alone, and it has to come back saying "you are viewing v1".
    const reloaded = await getCheckpoints(PROJECT);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.previewingCheckpointId).toBe(CP_V1);
    const afterReload = await servedProjectFiles({ id: PROJECT, lastCode: await liveLastCode() });
    expect(afterReload.ok).toBe(true);
    if (!afterReload.ok) return;
    expect(afterReload.previewing?.checkpointId).toBe(CP_V1);
    expect(afterReload.files['app/page.tsx']).toBe(V1[0].content);
  });

  it('goes back to the current version without restoring anything', async () => {
    await previewCheckpoint(PROJECT, CP_V1);

    const exit = await exitCheckpointPreview(PROJECT);

    expect(exit.ok).toBe(true);
    expect(await previewingId()).toBeNull();
    expect(await liveLastCode()).toBe(LIVE_LAST_CODE);
    const served = await servedProjectFiles({ id: PROJECT, lastCode: await liveLastCode() });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.previewing).toBeNull();
    expect(served.files['app/page.tsx']).toBe(V2[0].content);
  });

  it('releases the project lock, so the next generation is not parked behind a preview', async () => {
    await previewCheckpoint(PROJECT, CP_V1);

    const rows = await prisma.$queryRaw<Array<{ lockedById: string | null }>>`
      SELECT "lockedById" FROM "Project" WHERE id = ${PROJECT}
    `;
    expect(rows[0]?.lockedById).toBeNull();
  });

  it('refuses a preview of a pruned version instead of marking one nothing can show', async () => {
    await prisma.checkpoint.update({
      where: { id: CP_V1 },
      data: { snapshotPruned: true },
    });

    const result = await previewCheckpoint(PROJECT, CP_V1);

    expect(result.ok).toBe(false);
    expect(await previewingId()).toBeNull();
    expect(await liveLastCode()).toBe(LIVE_LAST_CODE);
  });
});
