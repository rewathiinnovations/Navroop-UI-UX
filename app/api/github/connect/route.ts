/**
 * GitHub OAuth account-linking (NOT login).
 *
 * Manual setup required:
 * - GITHUB_OAUTH_CLIENT_ID
 * - GITHUB_OAUTH_CLIENT_SECRET
 * - GITHUB_OAUTH_CALLBACK_URL
 * must be set, and the callback URL registered on the GitHub OAuth App.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { loginModalHref } from '@/lib/auth/public-login';
import { getGithubOAuthConfig, profileGithubRedirect } from '@/lib/github/oauth-config';
import {
  createOAuthState,
  GITHUB_OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
} from '@/lib/github/oauth-state';

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(new URL(loginModalHref('/api/github/connect'), request.url));
  }

  const { clientId, callbackUrl, configured } = getGithubOAuthConfig();
  if (!configured) {
    return NextResponse.redirect(profileGithubRedirect(request.url, 'error'));
  }

  try {
    const { state, cookieValue } = createOAuthState();
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', callbackUrl);
    authorize.searchParams.set('scope', 'repo');
    authorize.searchParams.set('state', state);

    const response = NextResponse.redirect(authorize);
    response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, cookieValue, oauthStateCookieOptions());
    return response;
  } catch {
    return NextResponse.redirect(profileGithubRedirect(request.url, 'error'));
  }
}
