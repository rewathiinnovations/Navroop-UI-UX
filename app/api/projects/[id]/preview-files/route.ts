import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { loadPublicPreviewSite } from '@/lib/preview/public-site';

/**
 * Anonymous, token-gated file read for the public `/preview-view` shell.
 * Same files as the signed-in workspace files API. GET only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, () => getPreviewFiles(request, params));
}

async function getPreviewFiles(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get('token');
  const site = await loadPublicPreviewSite({ projectId: id, token });
  if (!site) {
    return NextResponse.json({ error: 'Preview is not available' }, { status: 401 });
  }
  return NextResponse.json({
    success: true,
    stack: site.stack,
    designDirection: site.designDirection,
    files: site.files,
    structure: Object.keys(site.files).sort().join('\n'),
  });
}
