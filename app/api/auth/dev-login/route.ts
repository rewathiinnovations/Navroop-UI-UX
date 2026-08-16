import { NextRequest, NextResponse } from 'next/server';
import { signIn } from '@/auth';
import { getSessionUser, toPublicUser } from '@/lib/auth';
import { isDevQuickLoginEnabled } from '@/lib/dev-quick-login';
import { ensureAdminUser } from '@/lib/ensure-admin';
import { ensureMemberUser } from '@/lib/ensure-member';

export async function POST(request: NextRequest) {
  if (!isDevQuickLoginEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const role = body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : null;
    if (!role) {
      return NextResponse.json({ error: 'Choose admin or member' }, { status: 400 });
    }

    if (role === 'admin') {
      await ensureAdminUser();
    } else {
      await ensureMemberUser();
    }

    try {
      await signIn('credentials', {
        devRole: role,
        redirect: false,
      });
    } catch {
      return NextResponse.json({ error: 'Could not sign in' }, { status: 401 });
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Could not sign in' }, { status: 401 });
    }

    return NextResponse.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error('[dev-login]', error);
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 });
  }
}
