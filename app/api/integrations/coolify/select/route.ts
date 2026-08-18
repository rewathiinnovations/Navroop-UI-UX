import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { saveCoolifySelection } from '@/lib/integrations/coolify-connect';
import { getIntegration } from '@/lib/integrations/store';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    projectUuid?: string;
    projectName?: string;
    servers?: Array<{ uuid: string; name: string; ip: string; maxDeployments?: number }>;
  };
  const existing = await getIntegration('default', 'COOLIFY');
  const token = existing?.secrets.token;
  const baseUrl = existing?.config.baseUrl;
  if (!token || !baseUrl) {
    return NextResponse.json({ error: 'Verify the Coolify token first' }, { status: 409 });
  }
  if (!body.projectUuid?.trim()) {
    return NextResponse.json({ error: 'Select a Coolify project' }, { status: 422 });
  }
  const result = await saveCoolifySelection({
    userId: user.id,
    baseUrl,
    token,
    projectUuid: body.projectUuid,
    projectName: body.projectName,
    servers: body.servers ?? [],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(await listPublicIntegrations());
}
