import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { consumeGithubCsrf } from '@/lib/integrations/csrf';
import { convertGithubManifest } from '@/lib/integrations/github';
import { appUrl } from '@/lib/integrations/github-manifest';
import { saveSettings } from '@/lib/settings/resolve';

/**
 * GitHub redirects here after creating the connectors app from the manifest.
 * The one-time code converts to the app's credentials, which are saved into
 * the admin settings (encrypted like any hand-typed secret) — the Connect
 * button on /connectors works immediately, no copy-paste involved.
 */
export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const back = (query: string) =>
    NextResponse.redirect(new URL(`/admin/config?${query}#connectors`, appUrl()));

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const csrf = await consumeGithubCsrf(state);
  if (!csrf || csrf.userId !== user.id) return back('github=error&reason=state');
  if (!code) return back('github=error&reason=code');

  try {
    const converted = await convertGithubManifest(code);
    if (!converted.client_id || !converted.client_secret) {
      return back('github=error&reason=credentials');
    }
    await saveSettings(
      [
        { key: 'github.oauth.clientId', value: converted.client_id },
        { key: 'github.oauth.clientSecret', value: converted.client_secret },
        { key: 'github.oauth.callbackUrl', value: `${appUrl()}/api/github/callback` },
      ],
      { id: user.id, email: user.email },
    );
    return back('github=created');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub app creation failed';
    return back(`github=error&reason=${encodeURIComponent(message.slice(0, 80))}`);
  }
}
