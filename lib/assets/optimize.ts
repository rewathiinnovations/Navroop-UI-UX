import sharp from 'sharp';

export const MAX_EDGE = 1920;

/**
 * Ceiling for a raw upload body, checked before it is buffered. Everything is
 * re-encoded to WebP capped at {@link MAX_EDGE}, so nothing legitimate needs
 * more than this — the admin thumbnail route settled on 4 MB for the same job
 * (`app/api/admin/templates/[id]/thumbnail/route.ts`); assets get headroom for
 * full-resolution photos.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Decoded-pixel ceiling handed to sharp. Its default is ~268 megapixels — a
 * small compressed file can declare dimensions that decode to a ~1 GB RGBA
 * buffer. 32 MP covers any real camera output headed for a 1920px WebP while
 * keeping the worst-case decode around 128 MB.
 */
export const MAX_INPUT_PIXELS = 32_000_000;

export type SniffedImageType = 'png' | 'jpeg' | 'webp' | 'gif';

/**
 * Magic-byte sniff for the image types uploads accept. The multipart
 * `file.type` is client-supplied, so the bytes are what decide — same rule the
 * image worker applies to its own responses (`lib/assets/image-worker.ts`).
 */
export function sniffImageType(buffer: Buffer): SniffedImageType | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export type OptimizedImage = {
  buffer: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
  contentType: 'image/webp';
  ext: 'webp';
};

export async function optimizeImage(
  input: Buffer,
  targetSize?: { width: number; height: number },
): Promise<OptimizedImage> {
  let pipeline = sharp(input, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  if (targetSize) {
    pipeline = pipeline.resize(targetSize.width, targetSize.height, { fit: 'cover' });
  } else {
    pipeline = pipeline.resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const buffer = await pipeline.webp({ quality: 82 }).toBuffer();
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? targetSize?.width ?? 0;
  const height = meta.height ?? targetSize?.height ?? 0;
  return {
    buffer,
    width,
    height,
    sizeBytes: buffer.length,
    contentType: 'image/webp',
    ext: 'webp',
  };
}
