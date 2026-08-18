import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { finishSentryOauthSelect, listSentryOrgs, listSentryProjects } from '@/lib/integrations/sentry-oauth';
import { getIntegration } from '@/lib/integrations/store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
  const token = row?.secrets.authToken;
  if (!token) return NextResponse.json({ error: 'Sentry OAuth is not in progress' }, { status: 409 });
  const orgs = await listSentryOrgs(token);
  if (!orgs.ok) return NextResponse.json({ error: orgs.error }, { status: 422 });
  return NextResponse.json({ orgs: orgs.orgs });
}

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    projectSlug?: string;
    createProject?: boolean;
    listProjects?: boolean;
  };
  const orgSlug = body.orgSlug?.trim() || '';
  if (!orgSlug) return NextResponse.json({ error: 'Organization is required' }, { status: 422 });
  if (body.listProjects) {
    const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
    const token = row?.secrets.authToken;
    if (!token) return NextResponse.json({ error: 'Sentry OAuth is not in progress' }, { status: 409 });
    const projects = await listSentryProjects(token, orgSlug);
    if (!projects.ok) return NextResponse.json({ error: projects.error }, { status: 422 });
    return NextResponse.json({ projects: projects.projects });
  }
  const result = await finishSentryOauthSelect({
    orgSlug,
    projectSlug: body.projectSlug,
    createProject: body.createProject,
    connectedById: user.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ...result, restartRequired: true, ...(await listPublicIntegrations()) });
}
