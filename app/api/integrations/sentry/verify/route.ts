import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { runSentryRoundTrip } from '@/lib/integrations/sentry-verify';
import { listPublicIntegrations } from '@/lib/integrations/public';

export const maxDuration = 60;

export async function POST() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const result = await runSentryRoundTrip();
  return NextResponse.json({ result, ...(await listPublicIntegrations()) });
}
