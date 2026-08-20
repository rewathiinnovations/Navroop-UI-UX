import { deflateSync, crc32 } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-173: `uploadAvatar` checked only `file.size === 0` and then buffered whatever
 * arrived — an authenticated member could hand the server an arbitrary number of
 * bytes, and a PDF or an HTML page named `.png` went straight into sharp, whose
 * decoder error left the action as an unhandled throw the form could not render.
 *
 * The two guards mirror `uploadProjectAsset` (tests/unit/asset-upload-guards.test.ts):
 * the ceiling is read off the declared part length *before* `arrayBuffer()` runs, and
 * the accepted formats are decided by magic bytes, not by the client's content type.
 * The order matters as much as the limit — a size check placed after the buffer has
 * already paid the memory it was meant to deny, so the refusal is asserted together
 * with `arrayBuffer` never having been called.
 */

const db = vi.hoisted(() => ({ userUpdate: vi.fn() }));
const auth = vi.hoisted(() => ({ requireSessionUser: vi.fn() }));
const storage = vi.hoisted(() => ({ upload: vi.fn() }));

/** next-auth's runtime cannot resolve `next/server` outside a Next build. */
vi.mock('@/auth', () => ({ unstable_update: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { user: { update: db.userUpdate } } }));
vi.mock('@/lib/auth', () => ({
  requireSessionUser: auth.requireSessionUser,
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  toPublicUser: (user: unknown) => user,
}));
vi.mock('@/lib/auth/session-invalidation', () => ({ passwordChangeWrites: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/storage', () => ({ upload: storage.upload }));

// Dynamic, not static: the module under test reads `@/auth` and `@/lib/storage` at
// evaluation time, so it has to load after the `vi.mock` factories above are in place.
const { uploadAvatar } = await import('@/lib/profile/actions');
const { MAX_UPLOAD_BYTES } = await import('@/lib/assets/optimize');
const { AVATAR_UPLOAD_LIMIT, clearAvatarUploadRateLimits } =
  await import('@/lib/assets/rate-limit');

const USER = { id: 'u-1', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };

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
  clearAvatarUploadRateLimits();
  auth.requireSessionUser.mockResolvedValue({ user: USER });
  storage.upload.mockResolvedValue({ url: '/uploads/avatars/u-1.webp' });
  db.userUpdate.mockImplementation(({ data }: { data: { avatarUrl?: string | null } }) =>
    Promise.resolve({ ...USER, avatarUrl: data.avatarUrl ?? null }),
  );
});

describe('uploadAvatar guards', () => {
  it('refuses a body over the upload ceiling without buffering it', async () => {
    const { file, arrayBuffer } = watched(
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'huge.png', { type: 'image/png' }),
    );

    const result = await uploadAvatar(formWith(file));

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'Image is too large — the limit is 10 MB',
    });
    // The whole point of the ordering: the bytes were never materialised.
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not an image, whatever the name and content type claim', async () => {
    const file = new File([Buffer.from('%PDF-1.7 definitely not an image')], 'avatar.png', {
      type: 'image/png',
    });

    const result = await uploadAvatar(formWith(file));

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'Upload a PNG, JPEG, WebP or GIF image',
    });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it('stores a real PNG as an optimised avatar', async () => {
    const result = await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')));

    expect(result).toMatchObject({ ok: true });
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/webp' }),
    );
    expect(db.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { avatarUrl: '/uploads/avatars/u-1.webp' } }),
    );
  });

  it('reports a storage failure as a refusal rather than throwing at the client', async () => {
    storage.upload.mockRejectedValue(new Error('S3 endpoint unreachable at 10.0.0.4'));

    const result = await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')));

    expect(result.ok).toBe(false);
    // The internal detail stays in the log, not in the sentence the form shows.
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).not.toContain('10.0.0.4');
    }
  });

  // Control: the guards are not simply refusing everything, and an empty part still
  // gets the sentence written for it.
  it('control: an empty part asks for a file rather than naming a size or a format', async () => {
    const result = await uploadAvatar(formWith(new File([], 'avatar.png')));

    expect(result).toMatchObject({ ok: false, error: 'Choose an image to upload' });
  });

  // The gap F-173's fix left open: both guards refuse one *bad* upload, and neither
  // bounds how many *good* ones an authenticated member can drive. Every accepted
  // call buffers the part and runs it through a sharp decode, so the loop is a
  // CPU-and-memory tap, not a storage nuisance.
  it('caps a user at the hourly avatar limit, as a typed refusal rather than a throw', async () => {
    for (let i = 0; i < AVATAR_UPLOAD_LIMIT; i += 1) {
      const allowed = await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')));
      expect(allowed, `attempt ${i + 1} of the hour's budget`).toMatchObject({ ok: true });
    }

    const { file, arrayBuffer } = watched(new File([encodePng(8, 8)], 'avatar.png'));
    // Resolves — the form renders `result.error`, so a rejected promise here would
    // surface as the unhandled Server Action error the F-173 fix set out to remove.
    await expect(uploadAvatar(formWith(file))).resolves.toMatchObject({
      ok: false,
      status: 429,
      error: 'Too many avatar uploads — try again in an hour',
    });
    // Refused before the bytes were read, so the 429 costs nothing to serve.
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalledTimes(AVATAR_UPLOAD_LIMIT);
  });

  it('meters per user, so one member cannot spend another member\u2019s budget', async () => {
    for (let i = 0; i < AVATAR_UPLOAD_LIMIT; i += 1) {
      await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')));
    }
    expect(await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')))).toMatchObject({
      ok: false,
      status: 429,
    });

    auth.requireSessionUser.mockResolvedValue({ user: { ...USER, id: 'u-2' } });

    expect(await uploadAvatar(formWith(new File([encodePng(8, 8)], 'avatar.png')))).toMatchObject({
      ok: true,
    });
  });

  it('control: an unauthenticated caller is refused before any file work', async () => {
    auth.requireSessionUser.mockResolvedValue({ user: null, error: 'Unauthorized', status: 401 });
    const { file, arrayBuffer } = watched(new File([encodePng(8, 8)], 'avatar.png'));

    const result = await uploadAvatar(formWith(file));

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(arrayBuffer).not.toHaveBeenCalled();
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
