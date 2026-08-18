import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { checkAllIntegrations, checkIntegration } from '@/lib/integrations/health';
import type { IntegrationKind } from '@/lib/integrations/types';
import { INTEGRATION_KINDS } from '@/lib/integrations/types';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { kind?: string };
  if (body.kind && INTEGRATION_KINDS.includes(body.kind as IntegrationKind)) {
    const result = await checkIntegration(body.kind as IntegrationKind);
    const data = await listPublicIntegrations();
    return NextResponse.json({ ...data, result });
  }
  const checked = await checkAllIntegrations();
  const data = await listPublicIntegrations();
  return NextResponse.json({ ...data, ...checked });
}
