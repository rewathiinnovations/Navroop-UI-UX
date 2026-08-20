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

  const { clientId, callbackUrl, configured } = await getGithubOAuthConfig();
  if (!configured) {
    return NextResponse.redirect(profileGithubRedirect(request.url, 'unconfigured'));
  }

  try {
    const { state, cookieValue } = createOAuthState();
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', callbackUrl);
    // `repo` is broad: read/write on every private repository the user can reach. It is what
    // a classic OAuth App needs to create and push a *private* repository, which is what this
    // flow does (`createPrivateRepo` + `pushViaGitDataApi`), so nothing narrower works here —
    // `public_repo` would publish the user's generated site to the world. The least-privilege
    // replacement is a user-to-server token from the connectors GitHub App, whose manifest
    // (`githubConnectorsManifest`) already registers this callback and asks for
    // contents+administration on *selected repositories only*; GitHub ignores `scope` for
    // that App type. What is fixed here rather than left as a claim: the granted scope is now
    // read back from GitHub and checked before a push (F-271, lib/github/connection.ts).
    authorize.searchParams.set('scope', 'repo');
    authorize.searchParams.set('state', state);

    const response = NextResponse.redirect(authorize);
    response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, cookieValue, oauthStateCookieOptions());
    return response;
  } catch {
    return NextResponse.redirect(profileGithubRedirect(request.url, 'error'));
  }
}
