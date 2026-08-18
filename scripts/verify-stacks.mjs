import { readFileSync } from 'node:fs';
import { PrismaClient } from '../generated/prisma/index.js';
import { z } from 'zod';

const STACK_IDS = ['NEXTJS', 'REACT', 'ASTRO', 'STATIC_HTML', 'VUE', 'SVELTE'];
const DEFAULT_STACK = 'NEXTJS';

const expected = {
  NEXTJS: { hasNodeDependencies: true, devCommand: 'next dev -p 5173 -H 0.0.0.0', installCommand: 'npm install', fileExtension: '.tsx' },
  REACT: { hasNodeDependencies: true, devCommand: 'vite --host', installCommand: 'npm install', fileExtension: '.jsx' },
  ASTRO: { hasNodeDependencies: true, devCommand: 'astro dev', installCommand: 'npm install', fileExtension: '.astro' },
  STATIC_HTML: { hasNodeDependencies: false, devCommand: 'npx serve . -l 5173', installCommand: null, fileExtension: '.html' },
  VUE: { hasNodeDependencies: true, devCommand: 'vite dev', installCommand: 'npm install', fileExtension: '.vue' },
  SVELTE: { hasNodeDependencies: true, devCommand: 'vite dev', installCommand: 'npm install', fileExtension: '.svelte' },
};

const createProjectSchema = z.object({
  initialPrompt: z.string().trim().min(1),
  stack: z.enum(STACK_IDS).default(DEFAULT_STACK),
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const stacksSrc = readFileSync(new URL('../lib/stacks.ts', import.meta.url), 'utf8');
const promptIndex = readFileSync(new URL('../lib/stack-prompts/index.ts', import.meta.url), 'utf8');
const reactPrompt = readFileSync(new URL('../lib/stack-prompts/react.ts', import.meta.url), 'utf8');
const nextPrompt = readFileSync(new URL('../lib/stack-prompts/nextjs.ts', import.meta.url), 'utf8');
const htmlPrompt = readFileSync(new URL('../lib/stack-prompts/static-html.ts', import.meta.url), 'utf8');
const genRoute = readFileSync(new URL('../app/api/generate-ai-code-stream/route.ts', import.meta.url), 'utf8');
const e2b = readFileSync(new URL('../lib/sandbox/providers/e2b-provider.ts', import.meta.url), 'utf8');
const injected = readFileSync(new URL('../lib/sandbox/providers/injected-base.ts', import.meta.url), 'utf8');
const modal = readFileSync(new URL('../lib/sandbox/providers/modal-provider.ts', import.meta.url), 'utf8');
const daytona = readFileSync(new URL('../lib/sandbox/providers/daytona-provider.ts', import.meta.url), 'utf8');
const planSrc = readFileSync(new URL('../lib/projects/plan.ts', import.meta.url), 'utf8');
const stackSetup = readFileSync(new URL('../lib/sandbox/stack-setup.ts', import.meta.url), 'utf8');
const stackResolve = readFileSync(new URL('../lib/stack-resolve.ts', import.meta.url), 'utf8');
const applyRoute = readFileSync(new URL('../app/api/apply-ai-code-stream/route.ts', import.meta.url), 'utf8');
// GET /api/get-sandbox-files is a thin wrapper; the manifest work lives here.
const filesRoute = readFileSync(new URL('../lib/sandbox/read-files.ts', import.meta.url), 'utf8');
const createSandbox = readFileSync(new URL('../app/api/create-ai-sandbox-v2/route.ts', import.meta.url), 'utf8');
// POST /api/create-ai-sandbox-v2 delegates to bootEphemeralSandbox, so the
// stack has to survive that hop as well as the route's own resolution.
const sandboxManager = readFileSync(new URL('../lib/sandbox/manager.ts', import.meta.url), 'utf8');
const nextScaffold = readFileSync(new URL('../lib/stacks/templates/nextjs.ts', import.meta.url), 'utf8');
const vueScaffold = readFileSync(new URL('../lib/stacks/templates/vue.ts', import.meta.url), 'utf8');
const svelteScaffold = readFileSync(new URL('../lib/stacks/templates/svelte.ts', import.meta.url), 'utf8');
const astroScaffold = readFileSync(new URL('../lib/stacks/templates/astro.ts', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../lib/stacks/routes.ts', import.meta.url), 'utf8');

for (const id of STACK_IDS) {
  const row = expected[id];
  check(`${id} registry hasNodeDependencies`, stacksSrc.includes(`id: '${id}'`) && stacksSrc.includes(`devCommand: '${row.devCommand}'`));
  check(`${id} fileExtension ${row.fileExtension}`, stacksSrc.includes(`fileExtension: '${row.fileExtension}'`));
}

check('STATIC_HTML installCommand null', stacksSrc.includes("installCommand: null"));
check('STATIC_HTML hasNodeDependencies false', /STATIC_HTML:[\s\S]*?hasNodeDependencies: false/.test(stacksSrc));
check('REACT copies vite --host', stacksSrc.includes("devCommand: 'vite --host'"));
check('getStack throws on unknown', stacksSrc.includes('Unknown stack') && stacksSrc.includes('Never silently falls through'));
check('getStackPrompt never silent React fallback', promptIndex.includes('Never silently falls through') && promptIndex.includes('incorrectly used the React prompt'));
check('REACT prompt is Vite/React', reactPrompt.includes('expert React developer') && reactPrompt.includes('Vite applications'));
check('stable prefix builder exists', promptIndex.includes('buildStablePromptPrefix') && promptIndex.includes('getStackPrompt'));
check('base-rules prepended', promptIndex.includes('BASE_RULES'));
check('NEXTJS prompt is App Router not React Vite', nextPrompt.includes('App Router') && nextPrompt.includes('page.tsx') && !nextPrompt.includes('expert React developer with perfect memory'));
check('STATIC_HTML prompt forbids frameworks', htmlPrompt.includes('NO React') && htmlPrompt.includes('vanilla'));
check('generation uses getStackPrompt', genRoute.includes('getStackPrompt(projectStack'));
check('generatePlan uses getStackPrompt', planSrc.includes('getStackPrompt(stackId'));
check('E2B skips install via shouldInstallPackages', e2b.includes('shouldInstallPackages(this.currentStack)'));
check('E2B non-REACT uses registry setup', e2b.includes('setupRegistryApp'));
check('registry has sandboxTemplate', stacksSrc.includes('sandboxTemplate') && stacksSrc.includes('code-interpreter-v1') && stacksSrc.includes('node22'));
check('REACT frameworkPackages react/react-dom only among Vite files', /REACT:[\s\S]*?frameworkPackages: \['react', 'react-dom'\]/.test(stacksSrc));
check('VUE frameworkPackages vue not react', /VUE:[\s\S]*?frameworkPackages: \['vue'\]/.test(stacksSrc));
check('STATIC_HTML frameworkPackages empty', /STATIC_HTML:[\s\S]*?frameworkPackages: \[\]/.test(stacksSrc));
check('Nuxt stays TODO', stacksSrc.includes('TODO(nuxt)') && vueScaffold.includes('TODO(nuxt)'));
check('E2B createSandbox uses registry template', e2b.includes('getSandboxTemplate') && e2b.includes('Sandbox.create(template.e2b'));
check('Modal and Daytona drivers exist', modal.includes('ModalProvider') && daytona.includes('DaytonaProvider'));
check('E2B REACT path still vite --host', e2b.includes('"dev": "vite --host"') && e2b.includes('react-dom'));
check('injected drivers use stack scaffold', injected.includes('stackScaffoldFiles') && injected.includes('setupViteApp'));
check('non-REACT setup writes stackScaffoldFiles', e2b.includes('stackScaffoldFiles') && stackSetup.includes('getStackScaffold'));
check('NEXTJS scaffold has app/page.tsx', nextScaffold.includes("path: 'app/page.tsx'") && nextScaffold.includes("path: 'app/layout.tsx'"));
check('ASTRO scaffold has src/pages/index.astro', astroScaffold.includes("path: 'src/pages/index.astro'"));
check('VUE scaffold is Vite not Nuxt', vueScaffold.includes('@vitejs/plugin-vue') && !vueScaffold.includes('nuxt.config'));
check('SVELTE scaffold has +page.svelte', svelteScaffold.includes("path: 'src/routes/+page.svelte'"));
check('apply skip list is registry-driven', applyRoute.includes('shouldSkipPackageInstall') && applyRoute.includes('isStackConfigFile'));
check('apply does not hardcode react skip only', !applyRoute.includes("pkg !== 'react' && pkg !== 'react-dom'"));
check('readSandboxFiles uses extractStackRoutes', filesRoute.includes('extractStackRoutes') && routesSrc.includes('extractNextAppRoutes'));
check(
  'create-sandbox passes stack to provider',
  createSandbox.includes('bootEphemeralSandbox(stackDef.id)') &&
    sandboxManager.includes('provider.createSandbox(definition.id)'),
);
check('resolveRequestStack projectId first', /if \(typeof input\.projectId === 'string' && input\.projectId\)/.test(stackResolve) && stackResolve.includes('always load Project.stack'));

const omitted = createProjectSchema.safeParse({ initialPrompt: 'Build a site' });
check('zod omitted stack defaults NEXTJS', omitted.success && omitted.data.stack === 'NEXTJS');
const next = createProjectSchema.safeParse({ initialPrompt: 'Build a site', stack: 'NEXTJS' });
check('zod accepts NEXTJS', next.success && next.data.stack === 'NEXTJS');
const bad = createProjectSchema.safeParse({ initialPrompt: 'Build a site', stack: 'NUXT' });
check('zod rejects unknown stack (no React coerce)', !bad.success);

const prisma = new PrismaClient();
const ids = [];

try {
  const owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!owner) throw new Error('Need at least one user');

  const createdDefault = await prisma.project.create({
    data: {
      name: 'stack-default',
      initialPrompt: 'default stack check',
      ownerId: owner.id,
    },
  });
  ids.push(createdDefault.id);
  check('insert without stack column override → NEXTJS', createdDefault.stack === 'NEXTJS');
  check('insert without designDirection → minimal', createdDefault.designDirection === 'minimal');

  const createdReact = await prisma.project.create({
    data: {
      name: 'stack-react-kept',
      initialPrompt: 'explicit react stays react',
      ownerId: owner.id,
      stack: 'REACT',
    },
  });
  ids.push(createdReact.id);
  check('explicit REACT insert is not rewritten to NEXTJS', createdReact.stack === 'REACT');

  const createdNext = await prisma.project.create({
    data: {
      name: 'stack-next',
      initialPrompt: 'next stack check',
      ownerId: owner.id,
      stack: 'NEXTJS',
    },
  });
  ids.push(createdNext.id);
  check('insert stack=NEXTJS stored', createdNext.stack === 'NEXTJS');

  const createdHtml = await prisma.project.create({
    data: {
      name: 'stack-html',
      initialPrompt: 'html stack check',
      ownerId: owner.id,
      stack: 'STATIC_HTML',
    },
  });
  ids.push(createdHtml.id);
  check('insert stack=STATIC_HTML stored', createdHtml.stack === 'STATIC_HTML');

  const loaded = await prisma.project.findUnique({ where: { id: createdDefault.id } });
  check('NEXTJS default project still loads', loaded?.id === createdDefault.id && loaded.stack === 'NEXTJS');
  const loadedReact = await prisma.project.findUnique({ where: { id: createdReact.id } });
  check('REACT project still loads as REACT', loadedReact?.stack === 'REACT');
} catch (error) {
  check('prisma stack checks', false, error instanceof Error ? error.message : String(error));
} finally {
  if (ids.length) {
    await prisma.project.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
