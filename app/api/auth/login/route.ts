import { NextRequest, NextResponse } from 'next/server';
import { signIn } from '@/auth';
import { validateEmail } from '@/lib/password';
import { ensureAdminUser } from '@/lib/ensure-admin';
import { getSessionUser, toPublicUser } from '@/lib/auth';
import {
  LOGIN_RATE_LIMIT_MESSAGE,
  allowLoginAttempt,
  recordLoginSuccess,
} from '@/lib/auth/login-rate-limit';

function clientIp(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    await ensureAdminUser();

    const { email, password } = await request.json();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const trimmedPassword = String(password || '');

    if (!validateEmail(trimmedEmail) || !trimmedPassword) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const ip = clientIp(request);
    if (!allowLoginAttempt(trimmedEmail, ip).allowed) {
      return NextResponse.json({ error: LOGIN_RATE_LIMIT_MESSAGE }, { status: 429 });
    }

    try {
      await signIn('credentials', {
        email: trimmedEmail,
        password: trimmedPassword,
        redirect: false,
      });
    } catch {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    recordLoginSuccess(trimmedEmail, ip);
    return NextResponse.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error('[login]', error);
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 });
  }
}
