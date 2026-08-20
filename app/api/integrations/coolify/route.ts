import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  CoolifyBaseUrlError,
  assertCoolifyBaseUrl,
  createCoolifyProject,
  discoverCoolify,
  stageCoolifyCandidate,
} from '@/lib/integrations/coolify-connect';

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

  // The address is operator-typed, so it goes through the SSRF guard before anything fetches
  // it. Without this the route was a working internal port scanner for anyone with ADMIN,
  // reflecting the response status back in its error message (F-228).
  let baseUrl: string;
  try {
    baseUrl = await assertCoolifyBaseUrl(body.baseUrl, { userId: user.id });
  } catch (cause) {
    if (cause instanceof CoolifyBaseUrlError) {
      return NextResponse.json({ error: cause.message }, { status: 422 });
    }
    throw cause;
  }

  const token = body.token.trim();
  const discovered = await discoverCoolify(baseUrl, token);
  if (!discovered.ok) return NextResponse.json({ error: discovered.error }, { status: 400 });

  let projects = discovered.projects;
  if (body.createProject) {
    const created = await createCoolifyProject(baseUrl, token);
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });
    projects = [...projects, created.project];
  }

  // Staged, not written live: an admin re-checking an existing connection must not take
  // publishing down between "find servers" and "save servers" (F-214).
  await stageCoolifyCandidate({ baseUrl, token, userId: user.id });

  return NextResponse.json({
    servers: discovered.servers,
    projects,
  });
}
