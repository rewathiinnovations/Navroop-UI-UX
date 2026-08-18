import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const data = await listPublicIntegrations();
  return NextResponse.json(data);
}
