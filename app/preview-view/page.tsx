import type { Metadata } from 'next';
import '@/components/app/studio/studio.css';
import PublicPreviewShell from '@/components/preview/PublicPreviewShell';
import { isLoopbackHostname } from '@/lib/preview/loopback';
import { resolvePublicPreviewFrameSrc } from '@/lib/preview/public-view';
import { previewStaticBaseUrl } from '@/lib/preview/url';

/**
 * Anonymous Open-in-new-tab shell. No login. The signed preview-static URL
 * is already minted (`GET /api/projects/[id]/preview`); this page only
 * validates its host against `previewStaticBaseUrl` and iframes it.
 * Anyone with the link can view until the 2-hour token expires.
 * Generated JS never runs top-level here (F-140).
 */
export const metadata: Metadata = {
  title: 'Preview · Navroop',
  referrer: 'no-referrer',
};

/**
 * Whether the preview origin is actually serving, checked from the server
 * because the browser cannot: the iframe is cross-origin, so a dead host
 * renders as a blank frame or a bare Traefik "no available server" with
 * nothing for the viewer to act on. HEAD, one attempt, short timeout - a
 * healthy host answers in milliseconds and an unhealthy one should not hold
 * the page hostage. Null means "answering" (any HTTP status below 500 counts:
 * 401/404 are the build's own answers, which the frame will show).
 */
async function probePreviewHost(iframeSrc: string): Promise<string | null> {
  const host = new URL(iframeSrc).host;
  // The loopback sibling is this same server: there is nothing upstream to
  // diagnose, and Node's resolver - unlike the browser's - is not required to
  // resolve `.localhost` subdomains, so probing it can only produce a false
  // "did not answer" over a frame that loads fine.
  if (isLoopbackHostname(new URL(iframeSrc).hostname)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const response = await fetch(iframeSrc, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (response.status >= 500) {
      return `${host} answered HTTP ${response.status}. The deployment behind it is down or has no route for this host - check the Coolify application the preview-static DNS record points at.`;
    }
    return null;
  } catch {
    return `${host} did not answer. The DNS record may be missing, or the deployment behind it is unreachable from here.`;
  }
}

export default async function PublicPreviewViewPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string }>;
}) {
  const { u } = await searchParams;
  const iframeSrc = resolvePublicPreviewFrameSrc(u, await previewStaticBaseUrl());
  const hostProblem = iframeSrc ? await probePreviewHost(iframeSrc) : null;
  return <PublicPreviewShell iframeSrc={iframeSrc} hostProblem={hostProblem} />;
}
