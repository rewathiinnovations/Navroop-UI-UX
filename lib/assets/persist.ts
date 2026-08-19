import type { ProjectAsset } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { assetStorageKey, fallbackAltText } from '@/lib/assets/keys';
import { optimizeImage } from '@/lib/assets/optimize';
import { upload } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';

export type ProjectAssetKind = 'generated' | 'stock' | 'uploaded';

export type PersistAssetInput = {
  projectId: string;
  buffer: Buffer;
  kind: ProjectAssetKind;
  prompt?: string | null;
  altText: string;
  targetSize?: { width: number; height: number };
};

/** The stored `ProjectAsset` row, named so callers do not reach for `ReturnType`. */
export type PersistedAsset = ProjectAsset;

export async function persistOptimizedAsset(input: PersistAssetInput): Promise<PersistedAsset> {
  const altText = fallbackAltText(input.altText);
  const optimized = await optimizeImage(input.buffer, input.targetSize);
  const storageKey = assetStorageKey(input.projectId, optimized.ext);
  const { url } = await upload(optimized.buffer, {
    key: storageKey,
    contentType: optimized.contentType,
  });
  const created = await prisma.projectAsset.create({
    data: {
      projectId: input.projectId,
      url,
      storageKey,
      kind: input.kind,
      prompt: input.prompt ?? null,
      altText,
      width: optimized.width,
      height: optimized.height,
      sizeBytes: optimized.sizeBytes,
    },
  });
  await adjustStorageBytes(optimized.sizeBytes);
  return created;
}
