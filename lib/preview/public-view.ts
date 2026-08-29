import { isLoopbackHostname } from './loopback';

/**
 * Public token-gated preview shell. The signed destination is minted by
 * `signedPreviewUrl` / `GET /api/projects/[id]/preview`. This module only
 * wraps that URL in a chrome-only app page and checks the iframe host
 * against the configured preview origin (F-140).
 */

export const PUBLIC_PREVIEW_VIEW_PATH = '/preview-view';

export function publicPreviewViewHref(signedUrl: string): string {
  return `${PUBLIC_PREVIEW_VIEW_PATH}?u=${encodeURIComponent(signedUrl)}`;
}

/**
 * The only iframe src the public shell may load: an https URL whose origin
 * is exactly the configured `previewStaticBaseUrl`, carrying the existing
 * signed token. Anything else (app origin, other hosts, relative, javascript,
 * missing token, missing preview origin) is refused — query-passing a full
 * URL is otherwise an open redirect / XSS sink.
 */
export function resolvePublicPreviewFrameSrc(
  candidate: string | null | undefined,
  previewOrigin: string | null | undefined,
): string | null {
  if (!candidate?.trim() || !previewOrigin?.trim()) return null;

  let preview: URL;
  let target: URL;
  try {
    preview = new URL(previewOrigin);
    target = new URL(candidate);
  } catch {
    return null;
  }

  // https everywhere real; plain http only between two loopback names, which
  // is the local sibling origin (`preview-static.localhost`) - it cannot leave
  // the machine, and browsers treat it as a secure context anyway.
  const bothLoopback = isLoopbackHostname(preview.hostname) && isLoopbackHostname(target.hostname);
  if (!bothLoopback && (preview.protocol !== 'https:' || target.protocol !== 'https:')) return null;
  if (target.username || target.password) return null;
  if (target.origin !== preview.origin) return null;
  if (!target.searchParams.get('token')) return null;

  return target.toString();
}
