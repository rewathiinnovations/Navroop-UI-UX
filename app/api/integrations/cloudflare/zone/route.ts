import { NextResponse } from 'next/server';
import {
  cloudflareWizardToken,
  connectCloudflareToken,
} from '@/lib/integrations/cloudflare-connect';
import { requireAdmin } from '@/lib/auth';
import { getIntegration } from '@/lib/integrations/store';
import { listPublicIntegrations } from '@/lib/integrations/public';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { zoneId?: string };
  if (!body.zoneId?.trim()) {
    return NextResponse.json({ error: 'Select a zone' }, { status: 422 });
  }
  const existing = await getIntegration(DEFAULT_WORKSPACE_ID, 'CLOUDFLARE');
  // The staged candidate first: while the picker is open the live token is still serving
  // publishes, and the operator is choosing a zone for the new one (F-214).
  const token = existing ? cloudflareWizardToken(existing) : null;
  if (!token) return NextResponse.json({ error: 'Paste the token first' }, { status: 409 });
  const result = await connectCloudflareToken({ token, userId: user.id, zoneId: body.zoneId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({
    ...(await listPublicIntegrations()),
    warning: 'warning' in result ? result.warning : null,
  });
}
