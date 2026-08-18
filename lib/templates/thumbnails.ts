/**
 * GOVERNING RULE
 * Thumbnail derivatives under /data/cache are reconstructible from object storage.
 * The durable copy is the uploaded object key — never the volume file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { capturePage } from '@/lib/import/capture';
import { log } from '@/lib/logger';
import { cachePath } from '@/lib/runtime/data-dir';
import { upload } from '@/lib/storage';
import { getSetting } from '@/lib/settings/resolve';

function cacheThumbnailDerivative(templateId: string, buffer: Buffer) {
  try {
    const dest = cachePath('thumbnails', `${templateId}.png`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buffer);
  } catch (error) {
    // The durable copy is the uploaded object, so this stays non-fatal — but an unwritable
    // volume shows up here first, and an empty catch is how that goes unnoticed.
    log.warn('templates.thumbnail_cache_write_failed', {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolves the public prefix once. Storage settings live in the database now,
 * so reading them is async — but mapping a list of rows to URLs must stay
 * synchronous, hence the split.
 */
export async function thumbnailUrlBase(): Promise<string | null> {
  if ((await getSetting('storage.driver')) !== 's3') return null;
  return ((await getSetting('storage.s3.publicUrl')) || '').replace(/\/+$/, '') || null;
}

export function thumbnailPublicUrl(
  key: string | null | undefined,
  base: string | null = null,
): string | null {
  if (!key) return null;
  const normalized = key.replace(/^\/+/, '');
  return base ? `${base}/${normalized}` : `/uploads/${normalized}`;
}

export function thumbnailObjectKey(templateId: string) {
  return `templates/${templateId}/thumb.png`;
}

export async function captureThumbnailFromUrl(url: string, templateId: string, userId?: string) {
  const capture = await capturePage(url, { userId });
  const key = thumbnailObjectKey(templateId);
  await upload(capture.desktopPng, { key, contentType: 'image/png' });
  cacheThumbnailDerivative(templateId, capture.desktopPng);
  return key;
}

export async function storeThumbnailBuffer(templateId: string, buffer: Buffer) {
  const key = thumbnailObjectKey(templateId);
  await upload(buffer, { key, contentType: 'image/png' });
  cacheThumbnailDerivative(templateId, buffer);
  return key;
}
