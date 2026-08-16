import sharp from 'sharp';

export const MAX_EDGE = 1920;

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
  let pipeline = sharp(input, { failOn: 'none' }).rotate();
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
