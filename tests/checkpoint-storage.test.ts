/**
 * Checkpoint object snapshots: gzip write/read, legacy fallback, thin eligibility.
 * Run: node --experimental-strip-types tests/checkpoint-storage.test.ts
 */
import { gunzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { asFileSnapshot, snapshotObjectKey, writeSnapshot, readSnapshot } =
  await import('../lib/checkpoints/snapshot-store.ts');
const { isThinEligible } = await import('../lib/checkpoints/retention.ts');

// A realistic component rather than a one-liner: at 142 raw bytes the previous
// fixture gzipped to 136, so "the stored payload is smaller than the raw JSON"
// held by six bytes and any fixture tweak would have flipped it.
const files = [
  {
    path: 'src/App.jsx',
    content: [
      "import { useState } from 'react';",
      '',
      'export default function App() {',
      '  const [count, setCount] = useState(0);',
      '  return (',
      '    <main className="page">',
      '      <h1 className="title">Hi</h1>',
      '      <p className="subtitle">You clicked {count} times.</p>',
      '      <button className="button" onClick={() => setCount(count + 1)}>',
      '        Click me',
      '      </button>',
      '    </main>',
      '  );',
      '}',
    ].join('\n'),
  },
  { path: 'package.json', content: '{"name":"demo"}' },
];

assert(
  snapshotObjectKey('proj_1', 'cp_9') === 'snapshots/proj_1/cp_9.json.gz',
  'snapshot key path',
);

const prevDriver = process.env.STORAGE_DRIVER;
const prevRoot = process.env.STORAGE_LOCAL_DIR;
const tempRoot = await mkdtemp(join(tmpdir(), 'navroop-snapshots-'));
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = tempRoot;

try {
  const written = await writeSnapshot('proj_1', 'cp_9', files);
  assert(written.snapshotKey === 'snapshots/proj_1/cp_9.json.gz', 'writeSnapshot returns key');
  assert(written.snapshotFileCount === 2, 'writeSnapshot counts files');
  assert(written.snapshotBytes > 0, 'writeSnapshot returns gzip bytes');

  const { get } = await import('../lib/storage/index.ts');
  const stored = await get(written.snapshotKey);
  assert(stored !== null, 'storage get returns gzip body');
  const rawJson = Buffer.from(JSON.stringify(files), 'utf8');
  // `|| stored!.length > 0` used to sit on the end of this. A gzip buffer is always
  // non-empty, so the compression claim in the first disjunct was never tested (F-610).
  assert(stored!.length < rawJson.length, 'gzip payload is smaller than the raw json');
  const unzipped = JSON.parse(gunzipSync(stored!).toString('utf8'));
  assert(asFileSnapshot(unzipped).length === 2, 'stored gzip decodes to files');

  const fromKey = await readSnapshot({
    snapshotKey: written.snapshotKey,
    fileSnapshot: null,
  });
  assert(
    fromKey.length === 2 && fromKey[0]?.path === 'src/App.jsx',
    'readSnapshot uses snapshotKey',
  );

  const legacy = await readSnapshot({
    snapshotKey: null,
    fileSnapshot: files,
  });
  assert(
    legacy.length === 2 && legacy[1]?.path === 'package.json',
    'readSnapshot falls back to fileSnapshot',
  );

  const empty = await readSnapshot({ snapshotKey: null, fileSnapshot: null });
  assert(empty.length === 0, 'readSnapshot empty when neither source exists');
} finally {
  if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = prevDriver;
  if (prevRoot === undefined) delete process.env.STORAGE_LOCAL_DIR;
  else process.env.STORAGE_LOCAL_DIR = prevRoot;
  await rm(tempRoot, { recursive: true, force: true });
}

const now = new Date('2026-08-16T12:00:00.000Z');
const old = new Date('2026-08-01T12:00:00.000Z');
const recent = new Date('2026-08-15T12:00:00.000Z');

assert(
  isThinEligible({
    id: 'old',
    latestId: 'latest',
    createdAt: old,
    isBookmarked: false,
    snapshotPruned: false,
    now,
    retentionDays: 7,
  }),
  'old unbookmarked non-latest is thin-eligible',
);
assert(
  !isThinEligible({
    id: 'latest',
    latestId: 'latest',
    createdAt: old,
    isBookmarked: false,
    snapshotPruned: false,
    now,
    retentionDays: 7,
  }),
  'latest is never thinned',
);
assert(
  !isThinEligible({
    id: 'starred',
    latestId: 'latest',
    createdAt: old,
    isBookmarked: true,
    snapshotPruned: false,
    now,
    retentionDays: 7,
  }),
  'bookmarked is never thinned',
);
assert(
  !isThinEligible({
    id: 'fresh',
    latestId: 'latest',
    createdAt: recent,
    isBookmarked: false,
    snapshotPruned: false,
    now,
    retentionDays: 7,
  }),
  'inside retention window is kept',
);
assert(
  !isThinEligible({
    id: 'already',
    latestId: 'latest',
    createdAt: old,
    isBookmarked: false,
    snapshotPruned: true,
    now,
    retentionDays: 7,
  }),
  'already pruned is skipped',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
