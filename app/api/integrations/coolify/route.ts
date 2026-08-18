import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createCoolifyProject, discoverCoolify } from '@/lib/integrations/coolify-connect';
import { upsertIntegration } from '@/lib/integrations/store';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    baseUrl?: string;
    token?: string;
    createProject?: boolean;
  };
  if (!body.baseUrl?.trim() || !body.token?.trim()) {
    return NextResponse.json({ error: 'Coolify URL and token are required' }, { status: 422 });
  }
  const discovered = await discoverCoolify(body.baseUrl, body.token);
  if (!discovered.ok) return NextResponse.json({ error: discovered.error }, { status: 400 });

  let projects = discovered.projects;
  if (body.createProject) {
    const created = await createCoolifyProject(body.baseUrl, body.token);
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });
    projects = [...projects, created.project];
  }

  await upsertIntegration({
    kind: 'COOLIFY',
    status: 'PENDING',
    config: { baseUrl: body.baseUrl.trim().replace(/\/+$/, '') },
    secrets: { token: body.token.trim() },
    connectedById: user.id,
    lastError: null,
  });

  return NextResponse.json({
    servers: discovered.servers,
    projects,
  });
}
