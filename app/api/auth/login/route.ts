import { NextRequest, NextResponse } from 'next/server';
import { signIn } from '@/auth';
import { validateEmail } from '@/lib/password';
import { ensureAdminUser } from '@/lib/ensure-admin';
import { getSessionUser, toPublicUser } from '@/lib/auth';
import { clientIpFrom } from '@/lib/auth/client-ip';
import {
  LOGIN_RATE_LIMIT_MESSAGE,
  allowLoginAttempt,
  recordLoginSuccess,
} from '@/lib/auth/login-rate-limit';

export async function POST(request: NextRequest) {
  try {
    // Malformed JSON is a client mistake, not a server failure — flow into the
    // 400 below instead of throwing out to the 500 catch.
    const { email, password } = await request.json().catch(() => ({}) as Record<string, unknown>);
    const trimmedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const trimmedPassword = String(password || '');

    if (!validateEmail(trimmedEmail) || !trimmedPassword) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    if (!allowLoginAttempt(trimmedEmail, clientIpFrom(request.headers)).allowed) {
      return NextResponse.json({ error: LOGIN_RATE_LIMIT_MESSAGE }, { status: 429 });
    }

    // After the throttle, never before it (F-321). Seeding used to be the first
    // statement in the handler, so an unauthenticated flood drove a database
    // query per request ahead of the very limiter that is supposed to bound it.
    // It still has to run before `signIn`, because on a fresh deployment the
    // seeded admin is the only account there is to sign in as.
    await ensureAdminUser();

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

    recordLoginSuccess(trimmedEmail);
    return NextResponse.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error('[login]', error);
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 });
  }
}
