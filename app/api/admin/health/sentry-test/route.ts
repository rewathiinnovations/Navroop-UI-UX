import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { sendObservabilityTestEvent } from '@/lib/observability/admin';

export const dynamic = 'force-dynamic';
// 10s confirmation wait + a 5s flush; the 60s budget was longer than the reverse proxy
// would hold the request open, so the admin saw a gateway timeout instead of a verdict.
export const maxDuration = 20;

export async function POST() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const result = await sendObservabilityTestEvent();
  return NextResponse.json(result);
}
