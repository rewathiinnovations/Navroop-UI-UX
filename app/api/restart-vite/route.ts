import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { restartDevServer } from '@/lib/sandbox/restart-dev';

export async function POST() {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  const result = await restartDevServer();

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true, message: result.message });
}
