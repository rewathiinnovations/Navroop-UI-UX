import { peekRootDomain } from '@/lib/integrations/store';
import { getSetting } from '@/lib/settings/resolve';
import { appOriginFromEnv } from './headers';
import { PREVIEW_STATIC_HOST_PREFIX } from './labels';
import { issuePreviewToken } from './token';

export function previewStaticHost(zoneName: string | null | undefined) {
  const zone = zoneName?.trim();
  if (!zone) return null;
  return `${PREVIEW_STATIC_HOST_PREFIX}.${zone}`;
}

/** Hostname (with optional port) from raw operator input; null when unusable. */
export function normalizePreviewHost(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The origin previews are served from: the connected Cloudflare zone, then the
 * `preview.host` setting, then nothing. Never the application's own origin — a
 * preview page is model-authored JavaScript, and opened top-level on the app
 * origin it would run with the viewer's session (F-140). A configured host
 * equal to the app host is refused for the same reason.
 */
export async function previewStaticBaseUrl(): Promise<string | null> {
  const zone = await peekRootDomain().catch(() => null);
  const zoneHost = previewStaticHost(zone);
  if (zoneHost) return `https://${zoneHost}`;

  const configured = normalizePreviewHost(await getSetting('preview.host'));
  if (configured && configured !== normalizePreviewHost(appOriginFromEnv())) {
    return `https://${configured}`;
  }
  return null;
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
}): Promise<string | null> {
  const base = await previewStaticBaseUrl();
  if (!base) return null;
  const token = issuePreviewToken({ projectId: input.projectId, userId: input.userId }, input.now);
  const path = buildPreviewPath(input.projectId, input.path ?? '/');
  const url = new URL(`${base}${path}`);
  url.searchParams.set('token', token);
  return url.toString();
}
