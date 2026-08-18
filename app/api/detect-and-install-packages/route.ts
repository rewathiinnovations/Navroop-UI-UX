import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { detectAndInstallPackages } from '@/lib/sandbox/detect-packages';

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  let files: unknown;
  try {
    ({ files } = await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = await detectAndInstallPackages({ files });

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    success: true,
    packagesInstalled: result.packagesInstalled,
    packagesFailed: result.packagesFailed,
    packagesAlreadyInstalled: result.packagesAlreadyInstalled,
    message: result.message,
    logs: result.logs,
  });
}
