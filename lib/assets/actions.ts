'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { fallbackAltText } from '@/lib/assets/keys';
import { generateImage, type GenerateAspect } from '@/lib/assets/generate-image';
import { persistOptimizedAsset } from '@/lib/assets/persist';
import { searchStockPhoto } from '@/lib/assets/stock-photo';
import { deleteObject } from '@/lib/storage';
import { adjustStorageBytes, WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { asCreditActionErr } from '@/lib/plans/http';
import { trackFailure } from '@/lib/observability/track';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';

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

function canMutate(user: SessionUser, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
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

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
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

  await deleteObject(existing.storageKey);
  await prisma.projectAsset.delete({ where: { id: assetId } });
  await adjustStorageBytes(-existing.sizeBytes);
  return { ok: true as const, data: { id: assetId } };
}
