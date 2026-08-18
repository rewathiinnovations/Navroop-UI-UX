import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { connectCloudflareToken } from '@/lib/integrations/cloudflare-connect';
import { getIntegration } from '@/lib/integrations/store';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { zoneId?: string };
  if (!body.zoneId?.trim()) {
    return NextResponse.json({ error: 'Select a zone' }, { status: 422 });
  }
  const existing = await getIntegration('default', 'CLOUDFLARE');
  const token = existing?.secrets.token;
  if (!token) return NextResponse.json({ error: 'Paste the token first' }, { status: 409 });
  const result = await connectCloudflareToken({ token, userId: user.id, zoneId: body.zoneId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(await listPublicIntegrations());
}
