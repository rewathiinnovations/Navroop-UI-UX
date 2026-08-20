import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { consumeGithubCsrf } from '@/lib/integrations/csrf';
import { convertGithubManifest } from '@/lib/integrations/github';
import { appPublicUrl } from '@/lib/settings/app-url';
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

  // Resolved once: the saved `github.oauth.callbackUrl` and the redirect back
  // to /admin/config must name the same origin GitHub was handed.
  const origin = await appPublicUrl();
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/admin/config?${query}#connectors`, origin));

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const consumed = await consumeGithubCsrf(state);
  if (!consumed.ok || consumed.payload.userId !== user.id) {
    // Per-flow state rows, so the reason distinguishes unknown / expired / already-used
    // instead of one opaque `state` (F-242).
    return back(
      `github=error&reason=${consumed.ok ? 'state-other-user' : `state-${consumed.reason}`}`,
    );
  }
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
        { key: 'github.oauth.callbackUrl', value: `${origin}/api/github/callback` },
      ],
      { id: user.id, email: user.email },
    );
    // Authorization and installation are separate on GitHub: a user token can
    // only reach repository resources (including POST /user/repos) while the
    // app is installed on the account. Send the admin straight to the install
    // screen — same as the deploy app's flow — or pushes fail with
    // "Resource not accessible by integration".
    if (converted.html_url) {
      return NextResponse.redirect(`${converted.html_url}/installations/new`);
    }
    return back('github=created');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub app creation failed';
    return back(`github=error&reason=${encodeURIComponent(message.slice(0, 80))}`);
  }
}
