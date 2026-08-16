/**
 * Persisted checkpoints: create, list, preview/exit (no Project write), restore append-only.
 *   npx tsx scripts/verify-checkpoints.ts
 */
import { config } from 'dotenv';
import { prisma } from '../lib/db';
import { createProject, persistProjectGeneration } from '../lib/projects/actions';
import { runWithActor } from '../lib/projects/plan';
import {
  createCheckpoint,
  createCheckpointAfterGeneration,
  exitCheckpointPreview,
  getCheckpoints,
  previewCheckpoint,
  restoreCheckpoint,
} from '../lib/checkpoints/actions';
import { setWriteSnapshot } from '../lib/checkpoints/write-sandbox';
import type { SessionUser } from '../lib/auth';

config({ path: '.env' });
config({ path: '.env.local', override: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const writes: { projectId: string; paths: string[] }[] = [];
setWriteSnapshot(async (projectId, files) => {
  writes.push({ projectId, paths: files.map((file) => file.path) });
});

const ids: string[] = [];

try {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take: 8 });
  const ownerRow = users.find((u) => u.role === 'MEMBER') || users[0];
  const otherRow = users.find((u) => u.id !== ownerRow?.id && u.role !== 'ADMIN');
  const adminRow = users.find((u) => u.role === 'ADMIN');
  assert(ownerRow && otherRow && adminRow, 'Need owner, other member, and admin');

  const toActor = (row: typeof ownerRow): SessionUser => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatarUrl,
  });
  const owner = toActor(ownerRow);
  const other = toActor(otherRow);
  const admin = toActor(adminRow);

  const created = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'Build a bakery site with a menu', skipPlanning: true }),
  );
  assert(created.ok, 'createProject failed');
  ids.push(created.data.id);

  await prisma.project.update({
    where: { id: created.data.id },
    data: {
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>Bakery</h1>}</file>',
      previewUrl: null,
    },
  });

  const first = await createCheckpoint(created.data.id, {
    trigger: 'initial',
    sourceMessage: 'Build a bakery site with a menu',
    previewUrl: null,
  });
  assert(first.trigger === 'initial', 'initial trigger');
  assert(first.label === 'Build a bakery site with a menu', 'label from sourceMessage');
  assert(first.thumbnailUrl == null, 'missing thumb stays null');
  const projectAfterFirst = await prisma.project.findUnique({ where: { id: created.data.id } });
  assert(projectAfterFirst?.thumbnailUrl == null, 'Project.thumbnailUrl unchanged when thumb is null');
  console.log('ok  createCheckpoint snapshot required, thumb best-effort');

  const listed = await runWithActor(owner, () => getCheckpoints(created.data.id));
  assert(listed.ok && listed.data.length === 1, 'getCheckpoints newest-first length');
  console.log('ok  getCheckpoints newest first');

  await prisma.project.update({
    where: { id: created.data.id },
    data: {
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>V2</h1>}</file>',
    },
  });
  const second = await createCheckpoint(created.data.id, {
    trigger: 'followup',
    sourceMessage: 'Make the hero larger and add a catering section please',
    previewUrl: null,
  });
  assert(second.label.length <= 40, 'label ~40 chars');
  assert(second.label.startsWith('Make the hero larger'), 'followup label from chat');

  const newestFirst = await runWithActor(other, () => getCheckpoints(created.data.id));
  assert(newestFirst.ok && newestFirst.data[0].id === second.id, 'any member can list; newest first');
  console.log('ok  followup label + member can list');

  const beforePreview = await prisma.project.findUnique({
    where: { id: created.data.id },
    select: { updatedAt: true, thumbnailUrl: true, lastCode: true },
  });
  const countBeforePreview = await prisma.checkpoint.count({ where: { projectId: created.data.id } });
  const previewed = await runWithActor(other, () => previewCheckpoint(created.data.id, first.id));
  assert(previewed.ok, 'member can preview');
  assert(writes.some((entry) => entry.paths.includes('src/App.jsx')), 'preview writes snapshot to sandbox');
  const countAfterPreview = await prisma.checkpoint.count({ where: { projectId: created.data.id } });
  const afterPreview = await prisma.project.findUnique({
    where: { id: created.data.id },
    select: { updatedAt: true, thumbnailUrl: true, lastCode: true },
  });
  assert(countAfterPreview === countBeforePreview, 'preview does not create Checkpoint');
  assert(afterPreview?.lastCode === beforePreview?.lastCode, 'preview does not touch Project.lastCode');
  console.log('ok  previewCheckpoint writes sandbox only');

  writes.length = 0;
  const exited = await runWithActor(other, () => exitCheckpointPreview(created.data.id));
  assert(exited.ok && exited.data.id === second.id, 'exit writes latest snapshot');
  assert(writes.length === 1, 'exit wrote once');
  console.log('ok  exitCheckpointPreview writes latest snapshot');

  const forbidden = await runWithActor(other, () => restoreCheckpoint(created.data.id, first.id));
  assert(!forbidden.ok && forbidden.status === 403, 'non-owner restore rejected');

  const restored = await runWithActor(owner, () => restoreCheckpoint(created.data.id, first.id));
  assert(restored.ok && restored.data.trigger === 'restore', 'owner restore appends');
  assert(restored.data.label.startsWith('Restored to version from'), 'restore label');
  const afterRestore = await prisma.checkpoint.findMany({
    where: { projectId: created.data.id },
    orderBy: { createdAt: 'desc' },
  });
  assert(afterRestore.length === 3, 'restore is append-only');
  assert(afterRestore[0].trigger === 'restore' && afterRestore[0].sourceMessage == null, 'restore sourceMessage null');
  console.log('ok  restoreCheckpoint owner/ADMIN append-only');

  const adminRestore = await runWithActor(admin, () => restoreCheckpoint(created.data.id, second.id));
  assert(adminRestore.ok, 'ADMIN can restore');

  const persistProject = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'A cafe landing page with hours', skipPlanning: true }),
  );
  assert(persistProject.ok, 'persist fixture');
  ids.push(persistProject.data.id);
  await prisma.project.update({
    where: { id: persistProject.data.id },
    data: {
      phase: 'BUILDING',
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>Cafe</h1>}</file>',
    },
  });
  const persisted = await runWithActor(owner, () =>
    persistProjectGeneration(persistProject.data.id, {
      generationStatus: 'ready',
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>Cafe</h1>}</file>',
      sourceMessage: 'ignored for approved-plan path',
    }),
  );
  assert(persisted.ok && persisted.data.phase === 'COMPLETE', 'persist ready → COMPLETE');
  const fromPersist = await prisma.checkpoint.findMany({ where: { projectId: persistProject.data.id } });
  assert(fromPersist.length === 1, 'persist ready creates checkpoint');
  assert(fromPersist[0].trigger === 'initial', 'BUILDING→COMPLETE uses initial when no plan');
  assert(fromPersist[0].sourceMessage === 'A cafe landing page with hours', 'uses initialPrompt');
  console.log('ok  persist ready on BUILDING → checkpoint initial');

  const followPersist = await runWithActor(owner, () =>
    persistProjectGeneration(persistProject.data.id, {
      generationStatus: 'ready',
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>Cafe v2</h1>}</file>',
      sourceMessage: 'Add weekend hours to the footer',
    }),
  );
  assert(followPersist.ok, 'follow-up persist');
  const followRows = await prisma.checkpoint.findMany({
    where: { projectId: persistProject.data.id },
    orderBy: { createdAt: 'desc' },
  });
  assert(followRows.length === 2, 'follow-up persist creates another checkpoint');
  assert(followRows[0].trigger === 'followup', 'COMPLETE+ready uses followup');
  assert(followRows[0].sourceMessage === 'Add weekend hours to the footer', 'followup source from chat');
  console.log('ok  persist ready on COMPLETE → checkpoint followup from chat');

  const empty = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'Empty snapshot project', skipPlanning: true }),
  );
  assert(empty.ok, 'empty fixture');
  ids.push(empty.data.id);
  let failed = false;
  try {
    await createCheckpointAfterGeneration(empty.data.id, { previousPhase: 'BUILDING' });
  } catch {
    failed = true;
  }
  assert(failed, 'empty snapshot fails loud');
  console.log('ok  empty snapshot fails loud');

  console.log('\nAll checkpoint checks passed.');
} finally {
  setWriteSnapshot(null);
  if (ids.length) {
    await prisma.checkpoint.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.generationEvent.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.projectPlan.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.project.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}
