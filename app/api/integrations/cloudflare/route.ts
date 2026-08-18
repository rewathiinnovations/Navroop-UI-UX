import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { connectCloudflareToken } from '@/lib/integrations/cloudflare-connect';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { token?: string; zoneId?: string };
  if (!body.token?.trim()) {
    return NextResponse.json({ error: 'Cloudflare token is required' }, { status: 422 });
  }
  const result = await connectCloudflareToken({
    token: body.token,
    userId: user.id,
    zoneId: body.zoneId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const data = await listPublicIntegrations();
  if (result.needsZone) {
    return NextResponse.json({ ...data, needsZone: true, zones: result.zones });
  }
  return NextResponse.json({ ...data, needsZone: false });
}
