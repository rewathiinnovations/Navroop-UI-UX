/**
 * Template library: usage increment, workspace privacy, admin gate,
 * project-count limit, and draft persistence of an edited prompt.
 * Run: pnpm exec tsx tests/templates.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { canManageTemplates } from '../lib/templates/auth.ts';
import {
  createProjectFromTemplate,
  type CreateFromTemplateDeps,
} from '../lib/templates/create.ts';
import {
  applyTemplateDraft,
  parseDraftRecord,
  serializeDraftRecord,
} from '../lib/templates/draft.ts';
import { incrementUsageCount } from '../lib/templates/usage.ts';
import { isVisibleToWorkspace, memberTemplateWhere } from '../lib/templates/visibility.ts';
import { BUILT_IN_TEMPLATES } from '../prisma/seed-templates.mjs';
import { listTemplateRows } from '../lib/templates/store.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

{
  const slugs = BUILT_IN_TEMPLATES.map((row) => row.slug);
  assert(BUILT_IN_TEMPLATES.length === 10, 'seeds ten built-in templates');
  for (const slug of [
    'restaurant',
    'portfolio-designer',
    'medical-clinic',
    'real-estate',
    'local-service',
    'personal-trainer',
    'law-firm',
    'photography-studio',
    'saas-landing',
    'event-wedding',
  ]) {
    assert(slugs.includes(slug), `includes slug ${slug}`);
  }
  assert(
    BUILT_IN_TEMPLATES.every((row) => row.prompt.split(/\s+/).length >= 150),
    'each built-in prompt is at least 150 words',
  );
  assert(
    BUILT_IN_TEMPLATES.every((row) => /example\.com/.test(row.prompt) || /\+91/.test(row.prompt)),
    'prompts use Indian phones or example.com hosts',
  );
  assert(
    !BUILT_IN_TEMPLATES.some((row) => /klarco/i.test(JSON.stringify(row))),
    'no klarco branding in templates',
  );
}

{
  assert(canManageTemplates('ADMIN') === true, 'ADMIN can manage templates');
  const member = canManageTemplates('MEMBER');
  assert(member === false, 'MEMBER cannot admin templates');
}

{
  const where = memberTemplateWhere('ws_a');
  assert(where.isActive === true, 'member list requires isActive');
  assert(
    JSON.stringify(where.OR) === JSON.stringify([{ workspaceId: null }, { workspaceId: 'ws_a' }]),
    'member list is built-in or this workspace only',
  );

  assert(
    isVisibleToWorkspace({ workspaceId: null, isActive: true }, 'ws_a') === true,
    'built-in active template is visible',
  );
  assert(
    isVisibleToWorkspace({ workspaceId: 'ws_a', isActive: true }, 'ws_a') === true,
    'own workspace template is visible',
  );
  assert(
    isVisibleToWorkspace({ workspaceId: 'ws_b', isActive: true }, 'ws_a') === false,
    'other workspace template is hidden',
  );
  assert(
    isVisibleToWorkspace({ workspaceId: null, isActive: false }, 'ws_a') === false,
    'inactive built-in is hidden from members',
  );
  assert(
    isVisibleToWorkspace({ workspaceId: null, isActive: false }, 'ws_a', { includeInactive: true }) ===
      true,
    'admin list can include inactive',
  );
}

{
  const draft = applyTemplateDraft(
    {
      text: 'original restaurant prompt',
      stack: 'NEXTJS',
      savedAt: 1,
      designDirection: 'editorial',
      importMode: 'reimagine',
    },
    {
      templateId: 'tmpl_restaurant',
      prompt: 'Edited: add a monsoon tasting menu and a reservation note for +91 98765 43210',
    },
  );
  assert(draft.templateId === 'tmpl_restaurant', 'draft stores templateId');
  assert(draft.text.includes('monsoon tasting menu'), 'draft stores the edited prompt');
  assert(draft.stack === 'NEXTJS', 'draft keeps the template stack');
  assert(draft.designDirection === 'editorial', 'draft keeps the template design direction');

  const raw = serializeDraftRecord(draft);
  const parsed = parseDraftRecord(JSON.parse(raw));
  assert(parsed?.templateId === 'tmpl_restaurant', 'edited templateId survives serialize/parse');
  assert(
    parsed?.text.includes('monsoon tasting menu') === true,
    'edited prompt survives serialize/parse (navigation)',
  );
}

{
  const denied: CreateFromTemplateDeps = {
    checkLimit: async () => ({
      ok: false,
      current: 5,
      limit: 5,
      reason: 'projects',
      message: 'Project limit reached',
    }),
    createProject: async () => {
      throw new Error('createProject must not run when the project limit is reached');
    },
    incrementUsageCount: async () => {
      throw new Error('usageCount must not increment when create is blocked');
    },
  };

  const blocked = await createProjectFromTemplate(
    {
      templateId: 'tmpl_any',
      prompt: 'Build a clinic site for Dr. Meera Iyer in Pune',
      stack: 'NEXTJS',
      designDirection: 'minimal',
    },
    denied,
  );
  assert(blocked.ok === false, 'template create fails when project limit is reached');
  if (!blocked.ok) {
    assert(blocked.status === 402, 'template create returns 402 for project limit');
    assert(blocked.error.toLowerCase().includes('project'), '402 message mentions projects');
  }
}

const PREFIX = 'tmpl_test_';
const WS_A = 'ws_templates_a';
const WS_B = 'ws_templates_b';

try {
  await prisma.$executeRawUnsafe(`DELETE FROM "Template" WHERE slug LIKE '${PREFIX}%'`);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });

  await prisma.workspace.create({ data: { id: WS_A, storageBytes: 0 } });
  await prisma.workspace.create({ data: { id: WS_B, storageBytes: 0 } });

  await prisma.$executeRaw`
    INSERT INTO "Template" (
      "id", "slug", "name", "description", "category", "stack", "prompt",
      "designDirection", "isActive", "isBuiltIn", "workspaceId", "usageCount", "sortOrder", "createdAt"
    ) VALUES
    (${`${PREFIX}builtin`}, ${`${PREFIX}builtin`}, 'Built-in cafe', 'A cafe', 'restaurant',
     'NEXTJS'::"Stack", 'Prompt', 'editorial', true, true, NULL, 4, 0, NOW()),
    (${`${PREFIX}ws_a`}, ${`${PREFIX}ws_a`}, 'Private A', 'Workspace A only', 'clinic',
     'NEXTJS'::"Stack", 'Prompt', 'minimal', true, false, ${WS_A}, 0, 1, NOW()),
    (${`${PREFIX}ws_b`}, ${`${PREFIX}ws_b`}, 'Private B', 'Workspace B only', 'clinic',
     'NEXTJS'::"Stack", 'Prompt', 'minimal', true, false, ${WS_B}, 0, 2, NOW()),
    (${`${PREFIX}inactive`}, ${`${PREFIX}inactive`}, 'Inactive', 'Hidden', 'saas',
     'NEXTJS'::"Stack", 'Prompt', 'technical', false, true, NULL, 0, 3, NOW())
  `;

  const before = await prisma.$queryRaw<Array<{ usageCount: number }>>`
    SELECT "usageCount" FROM "Template" WHERE id = ${`${PREFIX}builtin`}
  `;
  assert(before[0]?.usageCount === 4, 'seeded usageCount starts at 4');

  const next = await incrementUsageCount(`${PREFIX}builtin`);
  assert(next === 5, 'incrementUsageCount returns usageCount + 1');

  const after = await prisma.$queryRaw<Array<{ usageCount: number }>>`
    SELECT "usageCount" FROM "Template" WHERE id = ${`${PREFIX}builtin`}
  `;
  assert(after[0]?.usageCount === 5, 'usageCount increments atomically in the database');

  const rows = await prisma.$queryRaw<
    Array<{ id: string; workspaceId: string | null; isActive: boolean }>
  >`
    SELECT id, "workspaceId", "isActive" FROM "Template" WHERE slug LIKE ${`${PREFIX}%`}
  `;
  const visibleA = rows.filter((row) => isVisibleToWorkspace(row, WS_A));
  assert(
    visibleA.some((row) => row.id === `${PREFIX}builtin`),
    'workspace A sees built-in templates',
  );
  assert(
    visibleA.some((row) => row.id === `${PREFIX}ws_a`),
    'workspace A sees its private template',
  );
  assert(
    !visibleA.some((row) => row.id === `${PREFIX}ws_b`),
    'workspace A does not see workspace B templates',
  );
  assert(
    !visibleA.some((row) => row.id === `${PREFIX}inactive`),
    'members do not see inactive templates',
  );

  const listed = await listTemplateRows({ workspaceId: WS_A, sort: 'popular' });
  assert(
    listed.some((row) => row.id === `${PREFIX}builtin`) &&
      listed.some((row) => row.id === `${PREFIX}ws_a`) &&
      !listed.some((row) => row.id === `${PREFIX}ws_b`),
    'listTemplateRows hides other-workspace templates',
  );
} catch (error) {
  failed += 1;
  console.error('FAIL  db assertions', error);
} finally {
  await prisma.$executeRawUnsafe(`DELETE FROM "Template" WHERE slug LIKE '${PREFIX}%'`);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
