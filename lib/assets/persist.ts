import type { ProjectAsset } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { assetStorageKey, fallbackAltText } from '@/lib/assets/keys';
import { optimizeImage } from '@/lib/assets/optimize';
import { upload } from '@/lib/storage';
import { adjustStorageBytes, WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { checkLimit } from '@/lib/plans/limits';

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
  // The one place every asset write passes through — upload, generate, stock,
  // Openverse, the import rehost and the checkpoint thumbnail — so this is the
  // one place the plan's storage limit has to be read. Checked on the encoded
  // size, which is what will actually be stored, and before the upload: the
  // rollback for a refusal after the write is an object nothing points at.
  const storage = await checkLimit(WORKSPACE_ROW_ID, 'storage', optimized.sizeBytes);
  if (!storage.ok) {
    throw new Error(storage.message || 'Workspace storage limit is used up');
  }
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
