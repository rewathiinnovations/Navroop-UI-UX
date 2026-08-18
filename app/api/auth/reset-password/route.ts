import { NextRequest, NextResponse } from 'next/server';
import { resetPasswordWithToken } from '@/lib/password-reset/service';
import { jsonError } from '@/lib/api/error-response';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await resetPasswordWithToken({
      token: String((body as { token?: string }).token || ''),
      password: String((body as { password?: string }).password || ''),
    });
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    logError('auth.reset_password_failed', error);
    return jsonError('Password reset failed', 'RESET_FAILED', 500);
  }
}
