import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
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
  const csrf = await consumeGithubCsrf(state);
  if (!csrf || csrf.userId !== user.id) {
    return NextResponse.redirect(new URL('/admin/integrations?github=error&reason=state', origin));
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
        org: csrf.org,
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
