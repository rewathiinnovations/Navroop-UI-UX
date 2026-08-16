import { nanoid } from 'nanoid';

export function assetStorageKey(projectId: string, ext: string) {
  const safeExt = ext.replace(/^\./, '').toLowerCase() || 'webp';
  return `projects/${projectId}/assets/${nanoid(16)}.${safeExt}`;
}

export function avatarStorageKey(userId: string, ext: string) {
  const safeExt = ext.replace(/^\./, '').toLowerCase() || 'webp';
  return `users/${userId}/avatar/${nanoid(16)}.${safeExt}`;
}

export function fallbackAltText(prompt?: string | null) {
  const cleaned = (prompt ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Generated image';
}

export function isDataUrl(value?: string | null) {
  return Boolean(value?.startsWith('data:'));
}
