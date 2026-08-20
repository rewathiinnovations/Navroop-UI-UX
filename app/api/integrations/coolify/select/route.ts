import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { coolifyWizardCredentials, saveCoolifySelection } from '@/lib/integrations/coolify-connect';
import { getIntegration } from '@/lib/integrations/store';
import { listPublicIntegrations } from '@/lib/integrations/public';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    projectUuid?: string;
    projectName?: string;
    servers?: Array<{ uuid: string; name: string; ip: string; maxDeployments?: number }>;
  };
  const existing = await getIntegration(DEFAULT_WORKSPACE_ID, 'COOLIFY');
  // Prefers the candidate the first half of the wizard staged, falling back to the live
  // connection so re-picking a project on a connected Coolify does not need a fresh token.
  const wizard = existing ? coolifyWizardCredentials(existing) : null;
  if (!wizard) {
    return NextResponse.json({ error: 'Verify the Coolify token first' }, { status: 409 });
  }
  if (!body.projectUuid?.trim()) {
    return NextResponse.json({ error: 'Select a Coolify project' }, { status: 422 });
  }
  const result = await saveCoolifySelection({
    userId: user.id,
    baseUrl: wizard.baseUrl,
    token: wizard.token,
    projectUuid: body.projectUuid,
    projectName: body.projectName,
    servers: body.servers ?? [],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(await listPublicIntegrations());
}
