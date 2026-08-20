import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { log } from '@/lib/logger';
import { consumeGithubCsrf } from '@/lib/integrations/csrf';
import { convertGithubManifest } from '@/lib/integrations/github';
import { upsertIntegration } from '@/lib/integrations/store';
import { appPublicUrl } from '@/lib/settings/app-url';

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const origin = await appPublicUrl();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const consumed = await consumeGithubCsrf(state);
  if (!consumed.ok || consumed.payload.userId !== user.id) {
    // The state row is now per flow, so this no longer fires merely because a second admin
    // started a connect. When it does fire, the reason says whether the nonce was unknown,
    // expired or already used (F-242).
    log.warn('integrations.github_csrf_refused', {
      reason: consumed.ok ? 'other-user' : consumed.reason,
      userId: user.id,
    });
    const url = new URL('/admin/integrations', origin);
    url.searchParams.set('github', 'error');
    url.searchParams.set('reason', consumed.ok ? 'state-other-user' : `state-${consumed.reason}`);
    return NextResponse.redirect(url);
  }
  if (!code) {
    return NextResponse.redirect(new URL('/admin/integrations?github=error&reason=code', origin));
  }

  try {
    const converted = await convertGithubManifest(code);
    await upsertIntegration({
      kind: 'GITHUB_DEPLOY',
      status: 'PENDING',
      config: {
        appId: converted.id,
        slug: converted.slug,
        htmlUrl: converted.html_url,
        org: consumed.payload.org,
      },
      secrets: {
        pem: converted.pem,
        webhookSecret: converted.webhook_secret,
        clientId: converted.client_id,
        clientSecret: converted.client_secret,
      },
      connectedById: user.id,
      lastError: null,
    });
    const installUrl = `${converted.html_url}/installations/new`;
    return NextResponse.redirect(installUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub App create fail';
    await upsertIntegration({
      kind: 'GITHUB_DEPLOY',
      status: 'ERROR',
      lastError: message,
      connectedById: user.id,
    });
    return NextResponse.redirect(new URL('/admin/integrations?github=error', origin));
  }
}
