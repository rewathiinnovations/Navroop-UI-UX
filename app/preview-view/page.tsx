import type { Metadata } from 'next';
import '@/components/app/studio/studio.css';
import PublicPreviewShell from '@/components/preview/PublicPreviewShell';
import { loadPublicPreviewSite } from '@/lib/preview/public-site';
import { parsePublicPreviewViewSearch } from '@/lib/preview/public-view';

/**
 * Anonymous Open-in-new-tab shell. No login. The HMAC token is minted by
 * `GET /api/projects/[id]/preview`; this page validates it, loads the project's
 * files (checkpoint / lastCode), and renders BrowserPreview. Generated JS stays
 * inside the srcdoc iframe (F-140). Anyone with the link can view until the
 * 2-hour token expires.
 */
export const metadata: Metadata = {
  title: 'Preview · Navroop',
  referrer: 'no-referrer',
};

export default async function PublicPreviewViewPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; token?: string }>;
}) {
  const parsed = parsePublicPreviewViewSearch(await searchParams);
  const site = parsed
    ? await loadPublicPreviewSite({ projectId: parsed.projectId, token: parsed.token })
    : null;
  return <PublicPreviewShell site={site} />;
}
