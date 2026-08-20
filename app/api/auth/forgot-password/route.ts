import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/auth/client-ip';
import { requestPasswordReset } from '@/lib/password-reset/service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await requestPasswordReset({
      email: String((body as { email?: string }).email || ''),
      ip: clientIpFrom(request.headers),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[forgot-password]', error);
    return NextResponse.json({
      ok: true,
      message: 'If this email is registered, a link has been sent. Check inbox and spam.',
    });
  }
}
