/**
 * Asset storage, source routing, usage, and NEED_IMAGE intercept.
 * Run: node --experimental-strip-types tests/assets.test.ts
 */
import { deflateSync, crc32 } from 'node:zlib';
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

// `decide-source` is gone: the image worker generates every picture and stock is
// only its fallback, so nothing routes between the two any more.
const { parseNeedImageDirectives, replaceNeedImageTokens } =
  await import('../lib/assets/need-image.ts');
const { assetStorageKey, fallbackAltText } = await import('../lib/assets/keys.ts');
const { IMAGE_GENERATION_ESTIMATE } = await import('../lib/usage-estimates.ts');
const { calculateEventCost } = await import('../lib/consumption/cost.ts');
const { formatAssetManifest } = await import('../lib/assets/manifest.ts');

const parsed = parseNeedImageDirectives(`
NEED_IMAGE: a chef in a kitchen | 16:9
<img src="NEED_IMAGE: abstract gradient hero | 1:1" />
`);
assert(parsed.length === 2, 'parses two NEED_IMAGE directives');
assert(parsed[0]?.description.includes('chef'), 'first directive keeps description');
assert(parsed[0]?.aspect === '16:9', 'first directive keeps aspect');
assert(parsed[1]?.aspect === '1:1', 'inline src directive keeps aspect');

const replaced = replaceNeedImageTokens('src="NEED_IMAGE: abstract gradient hero | 1:1"', [
  { token: 'NEED_IMAGE: abstract gradient hero | 1:1', url: '/uploads/hero.webp' },
]);
assert(replaced.includes('/uploads/hero.webp'), 'replaces NEED_IMAGE token with asset URL');
assert(!replaced.includes('NEED_IMAGE:'), 'no leftover NEED_IMAGE after replace');

const key = assetStorageKey('proj_1', 'webp');
assert(key.startsWith('projects/proj_1/assets/'), 'asset key uses projects/{id}/assets/');
assert(key.endsWith('.webp'), 'asset key keeps extension');

assert(fallbackAltText('  ') === 'Generated image', 'empty prompt still yields non-empty alt');
assert(
  fallbackAltText('A red bicycle on a cobblestone street').length > 0,
  'prompt alt is never empty',
);

assert(IMAGE_GENERATION_ESTIMATE === 0.04, 'IMAGE_GENERATION_ESTIMATE is 0.04');
assert(calculateEventCost('image', false) === 0.04, 'image kind costs 0.04 without sandbox extras');
assert(calculateEventCost('image', true) === 0.04, 'image kind ignores url-clone extras');

const manifest = formatAssetManifest([
  {
    url: '/uploads/a.webp',
    altText: 'Chef plating pasta',
    width: 1600,
    height: 900,
    kind: 'stock',
  },
]);
assert(manifest.includes('/uploads/a.webp'), 'manifest lists url');
assert(manifest.includes('Chef plating pasta'), 'manifest lists altText');
assert(manifest.includes('1600x900'), 'manifest lists dimensions');
assert(manifest.includes('stock'), 'manifest lists kind');

const prevDriver = process.env.STORAGE_DRIVER;
const prevRoot = process.env.STORAGE_LOCAL_DIR;
const tempRoot = await mkdtemp(join(tmpdir(), 'navroop-uploads-'));
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = tempRoot;

try {
  const { upload, exists, deleteObject } = await import('../lib/storage/index.ts');
  const stored = await upload(Buffer.from('hello-image'), {
    key: 'projects/p1/assets/test.bin',
    contentType: 'application/octet-stream',
  });
  assert(
    stored.url.includes('/uploads/projects/p1/assets/test.bin'),
    'local upload returns relative URL',
  );
  assert(await exists('projects/p1/assets/test.bin'), 'exists is true after upload');
  await deleteObject('projects/p1/assets/test.bin');
  assert(!(await exists('projects/p1/assets/test.bin')), 'exists is false after delete');
} finally {
  if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = prevDriver;
  if (prevRoot === undefined) delete process.env.STORAGE_LOCAL_DIR;
  else process.env.STORAGE_LOCAL_DIR = prevRoot;
  await rm(tempRoot, { recursive: true, force: true });
}

const { optimizeImage } = await import('../lib/assets/optimize.ts');
const png = encodePng(2000, 100);
const optimized = await optimizeImage(png);
assert(optimized.contentType === 'image/webp', 'optimize converts to WebP');
assert(optimized.width <= 1920 && optimized.height <= 1920, 'longest edge capped at 1920');
assert(optimized.width === 1920, 'landscape longest edge is width 1920');
assert(optimized.buffer.length < png.length, 'optimized buffer is smaller than raw PNG');
assert(optimized.ext === 'webp', 'optimized extension is webp');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

function encodePng(width: number, height: number) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 80);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  const compressed = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
