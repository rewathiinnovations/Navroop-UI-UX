import { deflateSync, crc32 } from 'node:zlib';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as uploadThumbnail } from '@/app/api/admin/templates/[id]/thumbnail/route';
import { MAX_THUMBNAIL_BYTES, MIN_THUMBNAIL_BYTES } from '@/lib/assets/optimize';

/**
 * The same hole as F-173, in the other upload entry point: this route buffered the whole
 * part with `arrayBuffer()` and only then compared `byteLength` against 4 MB, so the
 * ceiling was paid for before it was enforced — and a route handler is not covered by the
 * Server Action `bodySizeLimit`, so nothing else bounded it.
 *
 * It also never looked at the bytes. `storeThumbnailBuffer` uploads them verbatim and
 * labels them `image/png`, so any file at all could be stored and then served as an image
 * from our own origin under an admin-chosen key.
 */

const actions = vi.hoisted(() => ({ adminUploadThumbnail: vi.fn() }));

vi.mock('@/lib/templates/actions', () => ({
  adminUploadThumbnail: actions.adminUploadThumbnail,
}));

/**
 * The route reads its part from `request.formData()`. Parsing a real multipart body would
 * hand it a freshly built `File`, and the spy that proves the bytes were never read has to
 * be on the object the route actually sees — so the FormData is supplied at that seam.
 */
function post(form: FormData) {
  const request = new NextRequest('http://localhost:3000/api/admin/templates/t-1/thumbnail', {
    method: 'POST',
  });
  Object.defineProperty(request, 'formData', { value: () => Promise.resolve(form) });
  return uploadThumbnail(request, { params: Promise.resolve({ id: 't-1' }) });
}

function formWith(file: File) {
  const form = new FormData();
  form.set('file', file);
  return form;
}

/** A File whose `arrayBuffer()` fails the test if the guard reads it. */
function watched(file: File) {
  const arrayBuffer = vi.fn(() => Promise.reject(new Error('arrayBuffer must not be called')));
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
  return { file, arrayBuffer };
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.adminUploadThumbnail.mockResolvedValue({ ok: true, data: { template: { id: 't-1' } } });
});

describe('admin template thumbnail upload guards', () => {
  it('refuses an over-size part without buffering it', async () => {
    const { file, arrayBuffer } = watched(
      new File([new Uint8Array(MAX_THUMBNAIL_BYTES + 1)], 'thumb.png', { type: 'image/png' }),
    );

    const response = await post(formWith(file));

    expect(response.status).toBe(400);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(actions.adminUploadThumbnail).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not an image, whatever the name and content type claim', async () => {
    const file = new File([Buffer.from('<html><script>alert(1)</script></html>')], 'thumb.png', {
      type: 'image/png',
    });

    const response = await post(formWith(file));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Upload a PNG, JPEG, WebP or GIF image');
    expect(actions.adminUploadThumbnail).not.toHaveBeenCalled();
  });

  it('refuses a part too small to be an image header', async () => {
    const { file, arrayBuffer } = watched(
      new File([new Uint8Array(MIN_THUMBNAIL_BYTES - 1)], 'thumb.png'),
    );

    const response = await post(formWith(file));

    expect(response.status).toBe(400);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('stores a real PNG', async () => {
    const response = await post(formWith(new File([encodePng(8, 8)], 'thumb.png')));

    expect(response.status).toBe(200);
    expect(actions.adminUploadThumbnail).toHaveBeenCalledWith('t-1', expect.any(Buffer));
  });

  // Control: the guards are not refusing every request, and a missing part keeps its own
  // sentence rather than inheriting a size or format one.
  it('control: a missing part asks for a file', async () => {
    const response = await post(new FormData());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Upload a PNG or JPEG file');
    expect(actions.adminUploadThumbnail).not.toHaveBeenCalled();
  });
});

/** A real, decodable 8-bit RGB PNG (mirrors tests/unit/asset-upload-guards.test.ts). */
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

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}
