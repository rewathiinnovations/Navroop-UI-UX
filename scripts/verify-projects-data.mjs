import { PrismaClient } from '../generated/prisma/index.js';
import { z } from 'zod';

const prisma = new PrismaClient();

const createProjectSchema = z.object({
  name: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(100).optional(),
  ),
  initialPrompt: z.string().trim().min(1, 'initialPrompt is required'),
});

function nameFromPrompt(prompt) {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled project';
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const ids = [];

try {
  const users = await prisma.user.findMany({ take: 3, orderBy: { createdAt: 'asc' } });
  const owner = users[0];
  const other = users[1];
  const admin = users.find((u) => u.role === 'ADMIN') || users[2];
  if (!owner || !other || !admin) throw new Error('Need at least 2 users in the database');

  const longPrompt = 'Build a calm analytics dashboard with KPI cards';
  const parsed = createProjectSchema.safeParse({ initialPrompt: longPrompt });
  const empty = createProjectSchema.safeParse({ initialPrompt: '   ' });
  check('zod accepts non-empty initialPrompt', parsed.success);
  check('zod rejects empty initialPrompt', !empty.success && empty.error.issues.length > 0);
  check(
    'name derives first 40 chars',
    nameFromPrompt(longPrompt) === 'Build a calm analytics dashboard with KP',
    nameFromPrompt(longPrompt),
  );

  const created = await prisma.project.create({
    data: {
      name: nameFromPrompt(longPrompt),
      initialPrompt: longPrompt,
      ownerId: owner.id,
      status: 'draft',
      generationStatus: 'idle',
    },
  });
  ids.push(created.id);
  check('create stores ownerId + draft + generationStatus idle', created.ownerId === owner.id && created.status === 'draft' && created.generationStatus === 'idle');

  const otherProject = await prisma.project.create({
    data: {
      name: 'Other owner project',
      initialPrompt: 'Owned by the second user',
      ownerId: other.id,
      status: 'draft',
      generationStatus: 'idle',
    },
  });
  ids.push(otherProject.id);

  const shared = await prisma.project.findMany({
    where: { deletedAt: null, id: { in: ids } },
    select: { id: true, ownerId: true },
  });
  check(
    'shared workspace list sees both owners',
    shared.some((p) => p.ownerId === owner.id) && shared.some((p) => p.ownerId === other.id),
  );

  const mine = await prisma.project.findMany({
    where: { deletedAt: null, ownerId: owner.id, id: { in: ids } },
  });
  check('mine filter is ownerId only', mine.every((p) => p.ownerId === owner.id) && mine.some((p) => p.id === created.id));

  const canMutate = (user, ownerId) => user.id === ownerId || user.role === 'ADMIN';
  check('non-owner member cannot mutate', !canMutate(other, created.ownerId) && other.role !== 'ADMIN');
  check('admin can mutate someone else\'s project', canMutate(admin, created.ownerId));

  await prisma.project.update({ where: { id: created.id }, data: { deletedAt: new Date() } });
  const afterDelete = await prisma.project.findMany({
    where: { deletedAt: null, id: { in: ids } },
  });
  check('soft delete excludes from list', !afterDelete.some((p) => p.id === created.id));

  await prisma.project.update({ where: { id: created.id }, data: { deletedAt: null } });
  const afterRestore = await prisma.project.findFirst({ where: { id: created.id, deletedAt: null } });
  check('restore clears deletedAt', !!afterRestore);

  const copy = await prisma.project.create({
    data: {
      name: `${created.name} (copy)`.slice(0, 100),
      initialPrompt: created.initialPrompt,
      ownerId: other.id,
      status: 'draft',
      generationStatus: 'idle',
    },
  });
  ids.push(copy.id);
  check(
    'duplicate copies name + initialPrompt, new owner, draft',
    copy.initialPrompt === created.initialPrompt && copy.ownerId === other.id && copy.status === 'draft' && copy.sandboxId == null && copy.lastCode == null,
  );
} catch (error) {
  check('script ran without exception', false, String(error));
} finally {
  if (ids.length) await prisma.project.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} data-layer checks passed`);
process.exit(failed.length ? 1 : 0);
