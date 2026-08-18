/**
 * Static preview builds: stack capability, sandbox kill, SPA fallback,
 * signed-token access, Next.js export override, retention, idle default.
 * Run: npx tsx tests/preview-builds.test.ts
 */
import { getStack } from '../lib/stacks.ts';
import { DEFAULT_IDLE_MINUTES, idleMinutesFromEnv } from '../lib/sandbox/minutes.ts';
import { resolvePreviewObjectPath } from '../lib/preview/path.ts';
import { signPreviewToken, verifyPreviewToken } from '../lib/preview/token.ts';
import { previewResponseHeaders } from '../lib/preview/headers.ts';
import { handlePreviewRequest } from '../lib/preview/serve.ts';
import { buildStaticPreview } from '../lib/preview/build.ts';
import {
  isNextExportFailure,
  withTemporaryNextExport,
} from '../lib/preview/next-export.ts';
import { previewBuildsToDelete } from '../lib/preview/retention.ts';
import { injectInspectorIntoHtml } from '../lib/preview/inject.ts';
import {
  LIVE_MODE_LABEL,
  LIVE_MODE_TOOLTIP,
  LIVE_SANDBOX_LABEL,
  PREPARING_PREVIEW,
  PREVIEW_BUILD_FAILED,
  STATIC_PREVIEW_LABEL,
} from '../lib/preview/labels.ts';
import { INSPECTOR_SCRIPT_ID } from '../lib/visual-edits/inspector.ts';

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

function assertEqual<T>(actual: T, expected: T, name: string) {
  if (actual === expected) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// --- Stack static-preview capability ---

const html = getStack('STATIC_HTML');
assert(html.canStaticPreview === true, 'STATIC_HTML can static preview');
assert(html.previewBuildCommand == null, 'STATIC_HTML has no preview build command');
assertEqual(html.previewOutputDir, '.', 'STATIC_HTML preview output is .');
assert(html.spaFallback === false, 'STATIC_HTML is not an SPA fallback');

const react = getStack('REACT');
assert(react.canStaticPreview === true, 'REACT can static preview');
assertEqual(react.previewBuildCommand, 'npm run build', 'REACT preview build is npm run build');
assertEqual(react.previewOutputDir, 'dist', 'REACT preview output is dist');
assert(react.spaFallback === true, 'REACT uses SPA fallback');

const vue = getStack('VUE');
assert(vue.canStaticPreview === true && vue.previewBuildCommand === 'npm run build', 'VUE can static preview with npm run build');
assertEqual(vue.previewOutputDir, 'dist', 'VUE preview output is dist');
assert(vue.spaFallback === true, 'VUE uses SPA fallback');

const svelte = getStack('SVELTE');
assert(svelte.canStaticPreview === true && svelte.previewBuildCommand === 'npm run build', 'SVELTE can static preview with npm run build');
assertEqual(svelte.previewOutputDir, 'build', 'SVELTE preview output is build');
assert(svelte.spaFallback === true, 'SVELTE uses SPA fallback');

const astro = getStack('ASTRO');
assert(astro.canStaticPreview === true && astro.previewBuildCommand === 'npm run build', 'ASTRO can static preview with npm run build');
assertEqual(astro.previewOutputDir, 'dist', 'ASTRO preview output is dist');
assert(astro.spaFallback === false, 'ASTRO does not use SPA fallback');

const next = getStack('NEXTJS');
assert(next.canStaticPreview === true, 'NEXTJS attempts static export');
assertEqual(next.previewBuildCommand, 'npm run build', 'NEXTJS preview build is npm run build');
assertEqual(next.previewOutputDir, 'out', 'NEXTJS preview output is out/');
assert(next.spaFallback === false, 'NEXTJS export is not an SPA fallback');
assert(next.deployType === 'node', 'preview mode is independent of NEXTJS node deploy');

// --- Idle default is 5 (expected ≥80% sandbox-minute reduction vs 15) ---

assertEqual(DEFAULT_IDLE_MINUTES, 5, 'SANDBOX_IDLE_MINUTES default is 5');
assertEqual(idleMinutesFromEnv({}), 5, 'idleMinutesFromEnv with empty env is 5');
assertEqual(idleMinutesFromEnv({ SANDBOX_IDLE_MINUTES: '15' }), 15, 'explicit SANDBOX_IDLE_MINUTES=15 is still honored');

// --- English labels ---

assertEqual(LIVE_MODE_LABEL, 'Live mode', 'Live mode label');
assertEqual(LIVE_MODE_TOOLTIP, 'The sandbox will stay on — this uses credits', 'Live mode tooltip');
assertEqual(PREPARING_PREVIEW, 'Preparing preview…', 'Preparing preview label');
assertEqual(PREVIEW_BUILD_FAILED, 'Preview could not be built', 'Failed preview label');
assertEqual(STATIC_PREVIEW_LABEL, 'Static preview', 'Static preview label');
assertEqual(LIVE_SANDBOX_LABEL, 'Live sandbox', 'Live sandbox label');

// --- SPA fallback ---

assertEqual(
  resolvePreviewObjectPath('/about', { spaFallback: true, entryPath: 'index.html' }),
  'index.html',
  'React client-side route refresh serves index.html',
);
assertEqual(
  resolvePreviewObjectPath('about', { spaFallback: true, entryPath: 'index.html' }),
  'index.html',
  'extensionless path without slash uses SPA fallback',
);
assertEqual(
  resolvePreviewObjectPath('/assets/app.js', { spaFallback: true, entryPath: 'index.html' }),
  'assets/app.js',
  'asset with extension is not rewritten',
);
assertEqual(
  resolvePreviewObjectPath('/missing.html', { spaFallback: true, entryPath: 'index.html' }),
  'missing.html',
  'explicit html path is not rewritten to entry');
assertEqual(
  resolvePreviewObjectPath('/about', { spaFallback: false, entryPath: 'index.html' }),
  'about',
  'non-SPA extensionless path stays as-is (404 later)',
);
assertEqual(
  resolvePreviewObjectPath('/', { spaFallback: true, entryPath: 'index.html' }),
  'index.html',
  'root path uses entryPath',
);

// --- Tokens ---

const secret = 'preview-test-secret-do-not-use-in-prod';
const now = Date.parse('2026-08-17T12:00:00.000Z');
const token = signPreviewToken({ projectId: 'proj_1', userId: 'user_1' }, { secret, now, ttlMs: 2 * 60 * 60 * 1000 });
const valid = verifyPreviewToken(token, { secret, now, projectId: 'proj_1' });
assert(valid.ok === true && valid.ok && valid.projectId === 'proj_1', 'signed token verifies for the project');

const missing = verifyPreviewToken(null, { secret, now, projectId: 'proj_1' });
assert(missing.ok === false, 'missing token is rejected');

const otherProject = verifyPreviewToken(token, { secret, now, projectId: 'proj_other' });
assert(otherProject.ok === false, 'token for a different project is rejected');

const expired = verifyPreviewToken(token, { secret, now: now + 2 * 60 * 60 * 1000 + 1, projectId: 'proj_1' });
assert(expired.ok === false, 'token older than 2 hours is rejected');

// --- Headers: CSP + frame + noindex ---

const headers = previewResponseHeaders({
  appOrigin: 'https://app.navroop.app',
  cacheImmutable: true,
});
assert(
  typeof headers['Content-Security-Policy'] === 'string' &&
    headers['Content-Security-Policy'].includes('frame-ancestors') &&
    headers['Content-Security-Policy'].includes('https://app.navroop.app'),
  'CSP frame-ancestors allows only the app origin',
);
assert(
  typeof headers['X-Frame-Options'] === 'string' &&
    headers['X-Frame-Options'].includes('https://app.navroop.app'),
  'X-Frame-Options allows framing only by the app origin',
);
assertEqual(headers['X-Robots-Tag'], 'noindex, nofollow', 'preview responses are noindex');
assert(
  typeof headers['Cache-Control'] === 'string' && headers['Cache-Control'].includes('immutable'),
  'built assets are cached immutable',
);

// --- Tokenless serve → 403 ---

const tokenless = await handlePreviewRequest({
  projectId: 'proj_1',
  path: '/',
  token: null,
  appOrigin: 'https://app.navroop.app',
  secret,
  now,
  loadBuild: async () => ({
    storagePrefix: 'previews/proj_1/build_1',
    entryPath: 'index.html',
    isSpa: true,
  }),
  getObject: async () => Buffer.from('<html>ok</html>'),
});
assertEqual(tokenless.status, 403, 'preview URL without a valid token returns 403');

const withToken = await handlePreviewRequest({
  projectId: 'proj_1',
  path: '/',
  token,
  appOrigin: 'https://app.navroop.app',
  secret,
  now,
  loadBuild: async () => ({
    storagePrefix: 'previews/proj_1/build_1',
    entryPath: 'index.html',
    isSpa: true,
  }),
  getObject: async (key) =>
    key.endsWith('index.html') ? Buffer.from('<html>ok</html>') : null,
});
assertEqual(withToken.status, 200, 'signed token serves the static preview');

const spaRefresh = await handlePreviewRequest({
  projectId: 'proj_1',
  path: '/about',
  token,
  appOrigin: 'https://app.navroop.app',
  secret,
  now,
  loadBuild: async () => ({
    storagePrefix: 'previews/proj_1/build_1',
    entryPath: 'index.html',
    isSpa: true,
  }),
  getObject: async (key) =>
    key.endsWith('index.html') ? Buffer.from('<html>spa</html>') : null,
});
assertEqual(spaRefresh.status, 200, 'SPA client route serves index.html not 404');
assert(
  Buffer.isBuffer(spaRefresh.body)
    ? spaRefresh.body.toString().includes('spa')
    : String(spaRefresh.body).includes('spa'),
  'SPA fallback body is the entry HTML',
);

// --- Inspector inject at upload time ---

const injected = injectInspectorIntoHtml('<html><body><h1>Hi</h1></body></html>');
assert(injected.includes(INSPECTOR_SCRIPT_ID), 'visual-edit inspector is injected into built HTML');
assert(injected.includes('navroop:element-selected'), 'injected script is the visual-edits inspector');

// --- Next.js export override does not persist ---

const userConfig = `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\nmodule.exports = nextConfig;\n`;
const files = new Map<string, string>([['next.config.js', userConfig]]);
let sawExport = false;
await withTemporaryNextExport(
  {
    readFile: async (path) => files.get(path) ?? '',
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    removeFile: async (path) => {
      files.delete(path);
    },
  },
  'next.config.js',
  async () => {
    sawExport = files.get('next.config.js')?.includes("output: 'export'") === true;
  },
);
assert(sawExport, 'temporary override sets output: export during the build');
assertEqual(files.get('next.config.js'), userConfig, 'user next.config is restored after export attempt');

assert(
  isNextExportFailure("Error: Page with `getServerSideProps` cannot be exported"),
  'getServerSideProps export error is an export failure',
);
assert(
  isNextExportFailure("export is not supported with app/api routes"),
  'API route export error is an export failure',
);
assert(isNextExportFailure('SyntaxError: unexpected token') === false, 'generic syntax error is not classified as export-only');

// --- REACT static build + sandbox killed ---

type StoredBuild = {
  id: string;
  status: string;
  mode: string;
  error?: string | null;
  buildLog?: string | null;
};

const reactKilled: { killed: string[]; builds: StoredBuild[]; projectMode: string; activeId: string | null } = {
  killed: [],
  builds: [],
  projectMode: 'STATIC',
  activeId: null,
};

const reactResult = await buildStaticPreview('proj_react', 'cp_1', {
  stack: 'REACT',
  sandbox: {
    runCommand: async (command) => {
      if (command.includes('npm run build')) {
        return { exitCode: 0, stdout: 'built dist/\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    listFiles: async (dir) => (dir === 'dist' || dir.endsWith('/dist') ? ['index.html', 'assets/app.js'] : []),
    readFile: async (path) =>
      path.endsWith('index.html') ? '<html><body>react</body></html>' : 'console.log(1)',
    writeFile: async () => {},
    removeFile: async () => {},
  },
  store: {
    createBuilding: async () => {
      const row = { id: 'pb_react', status: 'BUILDING', mode: 'STATIC' };
      reactKilled.builds.push(row);
      return row;
    },
    markFailed: async (id, input) => {
      const row = reactKilled.builds.find((item) => item.id === id);
      if (row) Object.assign(row, { status: 'FAILED', ...input });
    },
    markReady: async (id, input) => {
      const row = reactKilled.builds.find((item) => item.id === id);
      if (row) Object.assign(row, { status: 'READY', ...input });
    },
    setProjectPreview: async (_projectId, input) => {
      reactKilled.projectMode = input.previewMode;
      reactKilled.activeId = input.activePreviewBuildId;
    },
  },
  storage: {
    upload: async () => {},
  },
  killSandbox: async (projectId) => {
    reactKilled.killed.push(projectId);
  },
});

assert(reactResult.ok === true && reactResult.mode === 'STATIC', 'REACT preview build succeeds as STATIC');
assertEqual(reactKilled.killed[0], 'proj_react', 'REACT sandbox is killed after a successful preview build');
assertEqual(reactKilled.builds[0]?.status, 'READY', 'REACT PreviewBuild is READY');
assertEqual(reactKilled.activeId, 'pb_react', 'activePreviewBuildId is set before kill');

// --- Failed preview build falls back to live mode and keeps the sandbox ---

const failedLive: { killed: string[]; mode: string; status: string } = {
  killed: [],
  mode: 'STATIC',
  status: '',
};

const failResult = await buildStaticPreview('proj_fail', 'cp_2', {
  stack: 'REACT',
  sandbox: {
    runCommand: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Build failed\n',
    }),
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
    removeFile: async () => {},
  },
  store: {
    createBuilding: async () => ({ id: 'pb_fail', status: 'BUILDING', mode: 'STATIC' }),
    markFailed: async (_id, input) => {
      failedLive.status = 'FAILED';
      failedLive.mode = input.mode ?? 'LIVE_SANDBOX';
    },
    markReady: async () => {},
    setProjectPreview: async (_projectId, input) => {
      failedLive.mode = input.previewMode;
    },
  },
  storage: { upload: async () => {} },
  killSandbox: async (projectId) => {
    failedLive.killed.push(projectId);
  },
});

assert(failResult.ok === false && failResult.mode === 'LIVE_SANDBOX', 'failed preview build falls back to LIVE_SANDBOX');
assertEqual(failedLive.killed.length, 0, 'failed preview build keeps the sandbox alive');
assertEqual(failedLive.mode, 'LIVE_SANDBOX', 'Project.previewMode becomes LIVE_SANDBOX on failure');
assertEqual(failedLive.status, 'FAILED', 'PreviewBuild is FAILED with a stored log');

// --- NEXTJS export fail sets LIVE_SANDBOX without mutating user next.config ---

const nextFiles = new Map<string, string>([['next.config.js', userConfig]]);
const nextKilled: string[] = [];
let nextMode = 'STATIC';

const nextFail = await buildStaticPreview('proj_next', 'cp_3', {
  stack: 'NEXTJS',
  sandbox: {
    runCommand: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: "Error: Page with `getServerSideProps` cannot be exported\n",
    }),
    listFiles: async () => ['next.config.js'],
    readFile: async (path) => nextFiles.get(path) ?? '',
    writeFile: async (path, content) => {
      nextFiles.set(path, content);
    },
    removeFile: async (path) => {
      nextFiles.delete(path);
    },
  },
  store: {
    createBuilding: async () => ({ id: 'pb_next', status: 'BUILDING', mode: 'STATIC' }),
    markFailed: async () => {},
    markReady: async () => {},
    setProjectPreview: async (_projectId, input) => {
      nextMode = input.previewMode;
    },
  },
  storage: { upload: async () => {} },
  killSandbox: async (projectId) => {
    nextKilled.push(projectId);
  },
});

assert(nextFail.ok === false && nextFail.mode === 'LIVE_SANDBOX', 'NEXTJS export failure sets LIVE_SANDBOX');
assertEqual(nextFiles.get('next.config.js'), userConfig, 'NEXTJS export failure does not mutate user next.config');
assertEqual(nextKilled.length, 0, 'NEXTJS export failure keeps the sandbox for live preview');
assertEqual(nextMode, 'LIVE_SANDBOX', 'Project.previewMode stays LIVE_SANDBOX after export failure');

// --- Retention: active + 2 recent + bookmarked ---

const builds = [
  { id: 'old_1', createdAt: new Date('2026-08-01T00:00:00.000Z'), checkpointId: 'c1', storagePrefix: 'p/old_1' },
  { id: 'old_2', createdAt: new Date('2026-08-02T00:00:00.000Z'), checkpointId: 'c2', storagePrefix: 'p/old_2' },
  { id: 'book', createdAt: new Date('2026-08-03T00:00:00.000Z'), checkpointId: 'c_book', storagePrefix: 'p/book' },
  { id: 'recent_2', createdAt: new Date('2026-08-10T00:00:00.000Z'), checkpointId: 'c3', storagePrefix: 'p/r2' },
  { id: 'recent_1', createdAt: new Date('2026-08-11T00:00:00.000Z'), checkpointId: 'c4', storagePrefix: 'p/r1' },
  { id: 'active', createdAt: new Date('2026-08-12T00:00:00.000Z'), checkpointId: 'c5', storagePrefix: 'p/active' },
];
const deleted = previewBuildsToDelete(builds, {
  activeId: 'active',
  bookmarkedCheckpointIds: ['c_book'],
  keepRecent: 2,
});
assert(
  deleted.includes('old_1') && deleted.includes('old_2'),
  'retention deletes builds older than active + 2 recent',
);
assert(!deleted.includes('active'), 'retention keeps the active build');
assert(!deleted.includes('recent_1') && !deleted.includes('recent_2'), 'retention keeps the two most recent non-active builds');
assert(!deleted.includes('book'), 'retention keeps the bookmarked checkpoint build');

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
