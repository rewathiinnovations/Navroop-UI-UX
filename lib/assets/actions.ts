'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { fallbackAltText } from '@/lib/assets/keys';
import { MAX_UPLOAD_BYTES, sniffImageType } from '@/lib/assets/optimize';
import { allowAssetUpload } from '@/lib/assets/rate-limit';
import { generateImage, type GenerateAspect } from '@/lib/assets/generate-image';
import { persistOptimizedAsset } from '@/lib/assets/persist';
import { searchStockPhoto } from '@/lib/assets/stock-photo';
import { deleteObject } from '@/lib/storage';
import { adjustStorageBytes, WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { asCreditActionErr } from '@/lib/plans/http';
import { trackFailure } from '@/lib/observability/track';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { canMutateOwned as canMutate } from '@/lib/auth/ownership';

export type ActionErr = { ok: false; error: string; status: number };
export type ActionOk<T> = { ok: true; data: T };

export type PublicAsset = {
  id: string;
  url: string;
  kind: string;
  prompt: string | null;
  altText: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
};

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
}

async function requireUser() {
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function toPublic(row: {
  id: string;
  url: string;
  kind: string;
  prompt: string | null;
  altText: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: Date;
}): PublicAsset {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    prompt: row.prompt,
    altText: row.altText,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadOwnedProject(projectId: string, user: SessionUser) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return { project: null, err: notFound() as ActionErr };
  if (!canMutate(user, project.ownerId)) return { project: null, err: forbidden() as ActionErr };
  return { project, err: null };
}

export async function listProjectAssets(projectId: string) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;

  const rows = await prisma.projectAsset.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  return { ok: true as const, data: rows.map(toPublic) };
}

export async function generateProjectImage(
  projectId: string,
  prompt: string,
  aspectRatio: GenerateAspect,
) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;
  const credits = await checkCredits(WORKSPACE_ROW_ID, user.id, 'image');
  if (!credits.ok) return asCreditActionErr(credits);
  try {
    const asset = await generateImage({
      projectId,
      userId: user.id,
      prompt,
      aspectRatio,
    });
    // Past this line the provider has been paid and the ProjectAsset row plus its
    // stored file exist. The debit therefore gets its own catch: when both shared
    // one, a CreditLimitError raised because a concurrent request took the last
    // credit between the pre-flight above and here returned `ok: false` while the
    // asset stayed behind — the user was told the generation failed, and real
    // provider spend was never billed to anyone. The work is kept, and the miss is
    // reported through `trackFailure` so it reaches Sentry: `creditsUsed` and the
    // CreditLedger under-count together, so /admin/usage still reconciles and a
    // stdout-only line was the operator's only clue that money went out unbilled.
    try {
      await consumeCredits(WORKSPACE_ROW_ID, user.id, 'image', projectId);
    } catch (error) {
      trackFailure('credits.image_debit_failed', error, {
        action: 'image',
        projectId,
        userId: user.id,
        assetId: asset.id,
      });
    }
    return { ok: true as const, data: toPublic(asset) };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message, status: 400 as const };
  }
}

export async function searchProjectStock(projectId: string, query: string) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;
  try {
    const asset = await searchStockPhoto({ projectId, query });
    return { ok: true as const, data: toPublic(asset) };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message, status: 400 as const };
  }
}

export async function uploadProjectAsset(projectId: string, formData: FormData) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;

  const altText = fallbackAltText(String(formData.get('altText') || ''));
  if (!String(formData.get('altText') || '').trim()) {
    return { ok: false as const, error: 'Alt text is required', status: 400 as const };
  }
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: 'A file is required', status: 400 as const };
  }
  // Checked before the body is buffered: route handlers are not covered by the
  // Server Action bodySizeLimit, so this is the only ceiling the upload has.
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false as const,
      error: 'Image is too large — the limit is 10 MB',
      status: 400 as const,
    };
  }
  // Counted only for requests that passed validation, so a typo cannot burn
  // the hour's budget — same in-process bucket the ZIP export uses.
  if (!allowAssetUpload(user.id).allowed) {
    return {
      ok: false as const,
      error: 'Upload limit reached — try again in an hour',
      status: 429 as const,
    };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    // The multipart content type is client-supplied; the bytes decide. sharp
    // would reject most non-images anyway, but a clean 400 beats a decoder
    // error, and this closes the "sharp accepts it" formats nobody intends
    // to serve (PDF, SVG) before any decode work happens.
    if (!sniffImageType(buffer)) {
      return {
        ok: false as const,
        error: 'Upload a PNG, JPEG, WebP or GIF image',
        status: 400 as const,
      };
    }
    const asset = await persistOptimizedAsset({
      projectId,
      buffer,
      kind: 'uploaded',
      prompt: file.name,
      altText,
    });
    return { ok: true as const, data: toPublic(asset) };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message, status: 400 as const };
  }
}

export async function updateProjectAssetAlt(projectId: string, assetId: string, altText: string) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;

  const nextAlt = altText.trim();
  if (!nextAlt) return { ok: false as const, error: 'Alt text is required', status: 400 as const };

  const existing = await prisma.projectAsset.findFirst({
    where: { id: assetId, projectId },
  });
  if (!existing) return { ok: false as const, error: 'Asset not found', status: 404 as const };

  const updated = await prisma.projectAsset.update({
    where: { id: assetId },
    data: { altText: nextAlt },
  });
  return { ok: true as const, data: toPublic(updated) };
}

export async function deleteProjectAsset(projectId: string, assetId: string) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const loaded = await loadOwnedProject(projectId, user);
  if (!loaded.project) return loaded.err;

  const existing = await prisma.projectAsset.findFirst({
    where: { id: assetId, projectId },
  });
  if (!existing) return { ok: false as const, error: 'Asset not found', status: 404 as const };

  // Row first, object second. A row-less object is reclaimed by the project
  // purge, which deletes the whole `projects/{id}/` prefix; an object-less row
  // is reclaimed by nothing and renders as a permanently broken tile.
  try {
    await prisma.projectAsset.delete({ where: { id: assetId } });
  } catch (error) {
    trackFailure('assets.delete_row_failed', error, {
      action: 'asset_delete',
      projectId,
      assetId,
      userId: user.id,
    });
    return {
      ok: false as const,
      error: 'Could not delete this image — try again',
      status: 500 as const,
    };
  }

  try {
    await deleteObject(existing.storageKey);
  } catch (error) {
    // The bytes are still stored, so they stay counted: decrementing here is how
    // the storage total drifts below what the bucket actually holds. The object
    // outlives its row until the project is purged, and that is worth a signal —
    // nothing else will ever mention this key again.
    trackFailure('assets.orphan_object', error, {
      action: 'asset_delete',
      projectId,
      assetId,
      storageKey: existing.storageKey,
      sizeBytes: existing.sizeBytes,
      userId: user.id,
    });
    return { ok: true as const, data: { id: assetId } };
  }

  await adjustStorageBytes(-existing.sizeBytes);
  return { ok: true as const, data: { id: assetId } };
}
