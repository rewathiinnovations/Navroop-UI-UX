import { NextRequest, NextResponse } from 'next/server';
import { requestPasswordReset } from '@/lib/password-reset/service';

function clientIp(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await requestPasswordReset({
      email: String((body as { email?: string }).email || ''),
      ip: clientIp(request),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[forgot-password]', error);
    return NextResponse.json({
      ok: true,
      message:
        'If this email is registered, a link has been sent. Check inbox and spam.',
    });
  }
}
