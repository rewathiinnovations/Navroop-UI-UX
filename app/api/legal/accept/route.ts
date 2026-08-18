import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { withRequest } from '@/lib/api/with-request';
import { acceptTermsForUser, getTermsStatus } from '@/lib/legal/register';
import { TERMS_REQUIRED_MESSAGE } from '@/lib/legal/terms';

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    return NextResponse.json(await getTermsStatus(user.id));
  });
}

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { acceptTerms?: boolean };
    if (!body.acceptTerms) {
      return NextResponse.json({ error: TERMS_REQUIRED_MESSAGE }, { status: 400 });
    }
    return NextResponse.json(await acceptTermsForUser(user.id));
  });
}
