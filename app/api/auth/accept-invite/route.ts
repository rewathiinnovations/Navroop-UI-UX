import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { acceptInviteWithToken } from '@/lib/invites/service';
import { logError } from '@/lib/logger';

/**
 * Where an invite link is redeemed (F-351). Public for the same reason
 * `POST /api/auth/reset-password` is: the caller has no session yet — obtaining one is the
 * point — and what stands in for it is a single-use sha256-hashed token with an expiry,
 * claimed by a conditional UPDATE inside the transaction that sets the password.
 */
export async function POST(request: NextRequest) {
  try {
    const raw: unknown = await request.json().catch(() => null);
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const result = await acceptInviteWithToken({
      token: typeof body.token === 'string' ? body.token : '',
      password: typeof body.password === 'string' ? body.password : '',
    });
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    logError('auth.accept_invite_failed', error);
    return jsonError('Could not accept the invite', 'ACCEPT_INVITE_FAILED', 500);
  }
}
