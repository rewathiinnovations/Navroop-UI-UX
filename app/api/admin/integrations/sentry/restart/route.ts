import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { restartNavroopApplication } from '@/lib/integrations/sentry-restart';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if ((body.confirm || '').trim().toLowerCase() !== 'restart') {
    return NextResponse.json({ error: 'Type restart to confirm. This interrupts the application.' }, { status: 422 });
  }
  const result = await restartNavroopApplication();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true });
}
