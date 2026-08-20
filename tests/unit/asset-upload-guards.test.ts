import { deflateSync, crc32 } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-121: `uploadProjectAsset` accepted any body of any size at any rate —
 * `Buffer.from(await file.arrayBuffer())` materialised whatever arrived and
 * handed it to sharp at its ~268-megapixel default. Route handlers are not
 * covered by the Server Action bodySizeLimit, so these checks are the only
 * ceiling the upload has. Goes red if the size cap, the magic-byte sniff, the
 * per-user rate limit or sharp's pixel limit is removed.
 */

const db = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const persist = vi.hoisted(() => ({ persistOptimizedAsset: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { project: { findFirst: db.projectFindFirst } },
}));

/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));

/** Not under test here, and it pulls prisma and storage in for real. */
vi.mock('@/lib/assets/persist', () => persist);
vi.mock('@/lib/assets/generate-image', () => ({ generateImage: vi.fn() }));
vi.mock('@/lib/assets/stock-photo', () => ({ searchStockPhoto: vi.fn() }));
vi.mock('@/lib/storage', () => ({ deleteObject: vi.fn() }));
vi.mock('@/lib/plans/limits', () => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));

const { uploadProjectAsset } = await import('@/lib/assets/actions');
const { MAX_UPLOAD_BYTES, MAX_INPUT_PIXELS, optimizeImage, sniffImageType } =
  await import('@/lib/assets/optimize');
const { UPLOAD_LIMIT, clearAssetUploadRateLimits } = await import('@/lib/assets/rate-limit');

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const PROJECT = 'p-assets';

const ASSET = {
  id: 'asset_1',
  url: '/uploads/a.webp',
  kind: 'uploaded',
  prompt: 'photo.png',
  altText: 'A photo',
  width: 8,
  height: 8,
  sizeBytes: 10,
  createdAt: new Date(),
};

function formWith(file: File) {
  const form = new FormData();
  form.set('altText', 'A photo');
  form.set('file', file);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAssetUploadRateLimits();
  auth.getSessionUser.mockResolvedValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id });
  persist.persistOptimizedAsset.mockResolvedValue(ASSET);
});

describe('uploadProjectAsset guards', () => {
  it('rejects a body over the upload ceiling before buffering it', async () => {
    const file = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'huge.png', {
      type: 'image/png',
    });

    const result = await uploadProjectAsset(PROJECT, formWith(file));

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });

  it('rejects a body whose bytes are not one of the accepted image formats', async () => {
    // The multipart content type lies; the bytes decide.
    const file = new File([Buffer.from('%PDF-1.7 definitely not an image')], 'photo.png', {
      type: 'image/png',
    });

    const result = await uploadProjectAsset(PROJECT, formWith(file));

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'Upload a PNG, JPEG, WebP or GIF image',
    });
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });

  it('accepts a small real PNG', async () => {
    const result = await uploadProjectAsset(
      PROJECT,
      formWith(new File([encodePng(8, 8)], 'photo.png')),
    );

    expect(result).toMatchObject({ ok: true });
    expect(persist.persistOptimizedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, kind: 'uploaded', altText: 'A photo' }),
    );
  });

  it('caps a user at the hourly upload limit', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i += 1) {
      const allowed = await uploadProjectAsset(
        PROJECT,
        formWith(new File([encodePng(8, 8)], 'photo.png')),
      );
      expect(allowed).toMatchObject({ ok: true });
    }

    const refused = await uploadProjectAsset(
      PROJECT,
      formWith(new File([encodePng(8, 8)], 'photo.png')),
    );

    expect(refused).toMatchObject({ ok: false, status: 429 });
    expect(persist.persistOptimizedAsset).toHaveBeenCalledTimes(UPLOAD_LIMIT);
  });
});

describe('sniffImageType', () => {
  it('recognises the four accepted formats and nothing else', () => {
    expect(sniffImageType(encodePng(8, 8))).toBe('png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'jpeg',
    );
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP')]))).toBe('webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="…">'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7 not an image'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe('optimizeImage pixel ceiling', () => {
  it('refuses a small file that declares more pixels than the cap', async () => {
    // A pixel bomb: a few hundred bytes whose IHDR declares one pixel more
    // than MAX_INPUT_PIXELS — sharp's own default would decode ~268 MP.
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;
    await expect(optimizeImage(pngWithDeclaredSize(side, side))).rejects.toThrow(/pixel/i);
  });
  it('still optimizes a real image', async () => {
    const optimized = await optimizeImage(encodePng(64, 32));
    expect(optimized.contentType).toBe('image/webp');
    expect(optimized.width).toBe(64);
  });
});

/** A real, decodable 8-bit RGB PNG (mirrors tests/assets.test.ts). */
function encodePng(width: number, height: number) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = 200;
      raw[offset + 1] = 120;
      raw[offset + 2] = 80;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Same header shape, but the pixel data is a stub: the bomb is the declaration. */
function pngWithDeclaredSize(width: number, height: number) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}
