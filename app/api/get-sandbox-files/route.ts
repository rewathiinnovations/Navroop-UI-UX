import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { readSandboxFiles } from '@/lib/sandbox/read-files';

export async function GET(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  // With a projectId, a missing live sandbox falls back to the persisted site
  // (checkpoint/lastCode tree) — the Code tab works after reaps and restarts.
  const projectId = request.nextUrl.searchParams.get('projectId');
  const result = await readSandboxFiles({ projectId });

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    success: true,
    files: result.files,
    structure: result.structure,
    fileCount: result.fileCount,
    manifest: result.manifest,
  });
}
