import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { sendObservabilityTestEvent } from '@/lib/observability/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const result = await sendObservabilityTestEvent();
  return NextResponse.json(result);
}
