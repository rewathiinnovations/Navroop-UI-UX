import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { readSandboxFiles } from '@/lib/sandbox/read-files';

export async function GET() {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  const result = await readSandboxFiles();

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
