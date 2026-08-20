/**
 * ZIP export from checkpoints (dead sandbox, older id, rate limit, README).
 * Run: pnpm exec tsx tests/export.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStack } from '../lib/stacks.ts';
import { writeSnapshot } from '../lib/checkpoints/snapshot-store.ts';
import {
  allowExport,
  buildExportFilename,
  buildExportReadme,
  clearExportRateLimits,
  collectExportFiles,
  filterExportFiles,
} from '../lib/export/index.ts';

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

const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
const { files: filtered, oversized } = filterExportFiles([
  { path: 'src/App.jsx', content: 'export default function App(){return null}' },
  { path: 'node_modules/react/index.js', content: 'module.exports={}' },
  { path: '.git/HEAD', content: 'ref: refs/heads/main' },
  { path: '.env', content: 'SECRET=1' },
  { path: 'app/.env.local', content: 'SECRET=2' },
  { path: 'public/huge.bin', content: huge },
  { path: 'README.md', content: 'keep me' },
]);

assert(
  filtered.every((file) => file.path === 'src/App.jsx' || file.path === 'README.md'),
  'filter drops node_modules, .git, .env, and files over 10 MB',
);
assert(
  !filtered.some(
    (file) =>
      file.path.includes('node_modules') ||
      file.path.includes('.git') ||
      file.path.includes('.env'),
  ),
  'filter never keeps excluded paths',
);
// F-796: the size rule is the only exclusion the README does not name structurally, so the
// oversized path has to come back out of the filter or the download lies about being complete.
assert(
  oversized.length === 1 && oversized[0].path === 'public/huge.bin',
  'filter reports the oversized path rather than dropping it silently',
);
assert(
  !oversized.some((file) => file.path.includes('node_modules') || file.path.includes('.env')),
  'structural exclusions are not reported as oversized',
);

const next = getStack('NEXTJS');
const readme = buildExportReadme({
  name: 'Saffron Clay',
  stack: 'NEXTJS',
  oversized,
});
assert(readme.includes('Saffron Clay'), 'README names the project');
assert(
  readme.includes(next.label) || readme.includes('NEXTJS') || readme.includes('Next.js'),
  'README names the stack',
);
assert(
  Boolean(next.installCommand) && readme.includes(next.installCommand!),
  'README documents the stack install command',
);
assert(readme.includes(next.devCommand), 'README documents the stack dev command');
assert(
  Boolean(next.buildCommand) && readme.includes(next.buildCommand!),
  'README documents the stack build command',
);
assert(readme.includes('public/huge.bin'), 'README names the file that was left out for size');
assert(
  buildExportReadme({ name: 'Saffron Clay', stack: 'NEXTJS' }).includes('over 10 MB') === false,
  'README stays quiet about the size rule when nothing was skipped',
);

assert(
  buildExportFilename('Saffron Clay', new Date('2026-08-17T10:00:00.000Z')) ===
    'saffron-clay-2026-08-17.zip',
  'filename is {slug}-{YYYY-MM-DD}.zip',
);

clearExportRateLimits();
const userId = 'user_export_rate';
for (let i = 0; i < 5; i += 1) {
  assert(allowExport(userId).allowed, `export ${i + 1} of 5 is allowed`);
}
assert(allowExport(userId).allowed === false, 'sixth export in the same hour is rate limited');
assert(allowExport('other_user').allowed, 'rate limit is per user');

const prevDriver = process.env.STORAGE_DRIVER;
const prevRoot = process.env.STORAGE_LOCAL_DIR;
const tempRoot = await mkdtemp(join(tmpdir(), 'navroop-export-'));
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = tempRoot;

try {
  const olderFiles = [
    { path: 'src/App.jsx', content: 'export default function App(){return <h1>Older</h1>}' },
    { path: 'package.json', content: '{"name":"older"}' },
  ];
  const latestFiles = [
    { path: 'src/App.jsx', content: 'export default function App(){return <h1>Latest</h1>}' },
    { path: 'package.json', content: '{"name":"latest"}' },
  ];
  const older = await writeSnapshot('proj_export', 'cp_old', olderFiles);
  const latest = await writeSnapshot('proj_export', 'cp_new', latestFiles);

  // No `sandboxStatus`: the parameter was removed in F-770 because it was `void`ed on
  // every path. The claim it was here to make — a dead sandbox does not block export —
  // is proven by the assertions below reading only from checkpoint snapshots.
  const { files: fromDeadSandbox } = await collectExportFiles({
    projectId: 'proj_export',
    checkpoints: [
      {
        id: 'cp_new',
        snapshotKey: latest.snapshotKey,
        fileSnapshot: null,
        createdAt: new Date('2026-08-17T12:00:00.000Z'),
      },
      {
        id: 'cp_old',
        snapshotKey: older.snapshotKey,
        fileSnapshot: null,
        createdAt: new Date('2026-08-16T12:00:00.000Z'),
      },
    ],
  });
  assert(
    fromDeadSandbox.some((file) => file.content.includes('Latest')),
    'dead sandbox still exports the latest checkpoint files',
  );
  assert(
    !fromDeadSandbox.some((file) => file.path.startsWith('node_modules/')),
    'export never reads the sandbox filesystem',
  );

  const { files: fromOlder } = await collectExportFiles({
    projectId: 'proj_export',
    checkpointId: 'cp_old',
    checkpoints: [
      {
        id: 'cp_new',
        snapshotKey: latest.snapshotKey,
        fileSnapshot: null,
        createdAt: new Date('2026-08-17T12:00:00.000Z'),
      },
      {
        id: 'cp_old',
        snapshotKey: older.snapshotKey,
        fileSnapshot: null,
        createdAt: new Date('2026-08-16T12:00:00.000Z'),
      },
    ],
  });
  assert(
    fromOlder.some((file) => file.content.includes('Older')) &&
      !fromOlder.some((file) => file.content.includes('Latest')),
    'exporting an older checkpoint id yields that version, not the latest',
  );
} finally {
  if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = prevDriver;
  if (prevRoot === undefined) delete process.env.STORAGE_LOCAL_DIR;
  else process.env.STORAGE_LOCAL_DIR = prevRoot;
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
