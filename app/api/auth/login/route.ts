import { NextRequest, NextResponse } from 'next/server';
import { signIn } from '@/auth';
import { validateEmail } from '@/lib/password';
import { ensureAdminUser } from '@/lib/ensure-admin';
import { getSessionUser, toPublicUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    await ensureAdminUser();

    const { email, password } = await request.json();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const trimmedPassword = String(password || '');

    if (!validateEmail(trimmedEmail) || !trimmedPassword) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
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

    return NextResponse.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error('[login]', error);
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 });
  }
}
