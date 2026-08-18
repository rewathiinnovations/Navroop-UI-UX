import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { withRequest } from '@/lib/api/with-request';
import { requestAccountData } from '@/lib/legal/data-request';

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      kind?: string;
      note?: string;
    };
    const kind = body.kind === 'deletion' ? 'deletion' : 'export';
    const result = await requestAccountData({
      userId: user.id,
      name: user.name,
      email: user.email,
      kind,
      note: body.note,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  });
}
