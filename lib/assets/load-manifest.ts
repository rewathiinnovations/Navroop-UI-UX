import { prisma } from '@/lib/db';
import { formatAssetManifest } from '@/lib/assets/manifest';

export async function loadAssetManifest(projectId?: string | null) {
  if (!projectId) return formatAssetManifest([]);
  try {
    const rows = await prisma.projectAsset.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { url: true, altText: true, width: true, height: true, kind: true },
    });
    return formatAssetManifest(rows);
  } catch (error) {
    console.warn('[assets] failed to load manifest', error);
    return formatAssetManifest([]);
  }
}
