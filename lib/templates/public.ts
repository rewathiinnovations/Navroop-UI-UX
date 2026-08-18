import { thumbnailPublicUrl } from './thumbnails';
import type { PublicTemplate, TemplateRow } from './types';

/** Maps a store row to the client-safe template shape. Not a Server Action. */
export function toPublic(row: TemplateRow): PublicTemplate {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    stack: String(row.stack),
    prompt: row.prompt,
    designDirection: row.designDirection,
    thumbnailUrl: thumbnailPublicUrl(row.thumbnailKey),
    previewUrl: row.previewUrl,
    isActive: row.isActive,
    isBuiltIn: row.isBuiltIn,
    workspaceId: row.workspaceId,
    usageCount: row.usageCount,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}
