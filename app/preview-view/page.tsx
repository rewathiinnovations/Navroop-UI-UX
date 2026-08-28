import type { Metadata } from 'next';
import '@/components/app/studio/studio.css';
import PublicPreviewShell from '@/components/preview/PublicPreviewShell';
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

export default async function PublicPreviewViewPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string }>;
}) {
  const { u } = await searchParams;
  const iframeSrc = resolvePublicPreviewFrameSrc(u, await previewStaticBaseUrl());
  return <PublicPreviewShell iframeSrc={iframeSrc} />;
}
