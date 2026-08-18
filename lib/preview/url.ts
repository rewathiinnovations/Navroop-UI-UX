import { peekRootDomain } from '@/lib/integrations/store';
import { appOriginFromEnv } from './headers';
import { PREVIEW_STATIC_HOST_PREFIX } from './labels';
import { issuePreviewToken } from './token';

export function previewStaticHost(zoneName: string | null | undefined) {
  const zone = zoneName?.trim();
  if (!zone) return null;
  return `${PREVIEW_STATIC_HOST_PREFIX}.${zone}`;
}

export async function previewStaticBaseUrl() {
  const zone = await peekRootDomain().catch(() => null);
  const host = previewStaticHost(zone);
  if (host) return `https://${host}`;
  return `${appOriginFromEnv()}/preview-static`;
}

export function buildPreviewPath(projectId: string, path = '/') {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `/${projectId}${suffix === '/' ? '/' : suffix}`;
}

export async function signedPreviewUrl(input: {
  projectId: string;
  userId: string;
  path?: string;
  now?: number;
}) {
  const token = issuePreviewToken(
    { projectId: input.projectId, userId: input.userId },
    input.now,
  );
  const base = await previewStaticBaseUrl();
  const path = buildPreviewPath(input.projectId, input.path ?? '/');
  const url = new URL(`${base}${path}`);
  url.searchParams.set('token', token);
  return url.toString();
}
