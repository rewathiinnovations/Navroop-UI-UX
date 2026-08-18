import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { upsertIntegration } from '@/lib/integrations/store';
import { createSentryOauthState, sentryAuthorizeUrl } from '@/lib/integrations/sentry-oauth';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { clientId?: string; clientSecret?: string };
  const clientId = body.clientId?.trim() || '';
  const clientSecret = body.clientSecret?.trim() || '';
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Client id and secret are required' }, { status: 422 });
  }
  const oauth = await createSentryOauthState(user.id);
  await upsertIntegration({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: 'SENTRY',
    status: 'PENDING',
    config: { oauthClientId: clientId },
    secrets: { clientSecret },
    connectedById: user.id,
  });
  return NextResponse.json({ url: sentryAuthorizeUrl({ clientId, state: oauth.state, challenge: oauth.challenge }) });
}
