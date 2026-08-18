import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/storage';
import { previewBuildTable, getProjectPreviewFields } from '@/lib/preview/db';
import { appOriginFromEnv } from '@/lib/preview/headers';
import { handlePreviewRequest } from '@/lib/preview/serve';
import { checkPreviewToken } from '@/lib/preview/token';

export const dynamic = 'force-dynamic';

function isGzip(buffer: Buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  const { projectId, path } = await params;
  const token = request.nextUrl.searchParams.get('token');
  const relative = `/${(path ?? []).join('/')}`;

  const result = await handlePreviewRequest({
    projectId,
    path: relative,
    token,
    appOrigin: appOriginFromEnv(),
    secret:
      process.env.AUTH_SECRET ||
      process.env.NEXTAUTH_SECRET ||
      process.env.ENCRYPTION_KEY ||
      '',
    now: Date.now(),
    loadBuild: async () => {
      const access = checkPreviewToken(token, projectId);
      if (!access.ok) return null;
      const project = await getProjectPreviewFields(projectId);
      if (!project?.activePreviewBuildId) return null;
      const build = await previewBuildTable().findUnique({ where: { id: project.activePreviewBuildId } });
      if (!build?.storagePrefix || build.status !== 'READY') return null;
      return {
        storagePrefix: build.storagePrefix,
        entryPath: build.entryPath,
        isSpa: build.isSpa,
      };
    },
    getObject: async (key) => get(key),
  });

  const headers = new Headers(result.headers);
  if (Buffer.isBuffer(result.body) && isGzip(result.body)) {
    headers.set('Content-Encoding', 'gzip');
  }
  const body = Buffer.isBuffer(result.body) ? new Uint8Array(result.body) : result.body;
  return new NextResponse(body, { status: result.status, headers });
}
