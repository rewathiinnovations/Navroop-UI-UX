import { peekRootDomain } from '@/lib/integrations/store';
import { getSetting } from '@/lib/settings/resolve';
import { getProjectPreviewFields } from './db';
import { appOriginFromEnv } from './headers';
import { PREVIEW_STATIC_HOST_PREFIX } from './labels';
import { isLoopbackUrl } from './loopback';
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
  // A loopback app serves its own previews: this instance's database holds the
  // projects and signs the tokens, so the zone host - which names the deployed
  // production instance - can never answer for it. Local development therefore
  // gets the loopback *sibling*, `preview-static.localhost:<port>`: `.localhost`
  // names are loopback by definition (RFC 6761) and a different host is a
  // different origin, so the F-140 isolation is the same as production's
  // sibling subdomain - host-only session cookies are not sent to it - while
  // the request lands on this same dev server, whose proxy already rewrites any
  // `preview-static.*` host onto the serving route.
  const appOrigin = appOriginFromEnv();
  if (isLoopbackUrl(appOrigin)) {
    const app = new URL(appOrigin);
    return `${app.protocol}//${PREVIEW_STATIC_HOST_PREFIX}.localhost${app.port ? `:${app.port}` : ''}`;
  }

  const zone = await peekRootDomain().catch(() => null);
  const zoneHost = previewStaticHost(zone);
  if (zoneHost) return `https://${zoneHost}`;

  const configured = normalizePreviewHost(await getSetting('preview.host'));
  if (configured && configured !== normalizePreviewHost(appOrigin)) {
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

/**
 * The only preview URL an internal auditor may fetch.
 *
 * Never `Project.previewUrl`: that column is owner-writable through
 * `PATCH /api/projects/[id]`, and the value reaches `page.goto`
 * (`lib/audit/a11y.ts`), a bare `fetch` (`lib/seo/live.ts`, which deliberately
 * skips `safeFetch`) and Lighthouse. Both audit entry points used to read it
 * into a variable and then overwrite it unconditionally, which worked but read
 * as a live fallback one careless edit away from a server-side request forgery
 * through three clients (F-759). There is no fallback: no active build means no
 * URL, and the file-based checks run on their own.
 */
export async function auditPreviewUrl(projectId: string, userId: string): Promise<string | null> {
  const preview = await getProjectPreviewFields(projectId);
  if (!preview?.activePreviewBuildId) return null;
  return signedPreviewUrl({ projectId, userId });
}
