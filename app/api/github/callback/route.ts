/**
 * GitHub OAuth account-linking callback (NOT login).
 *
 * Manual setup required:
 * - GITHUB_OAUTH_CLIENT_ID
 * - GITHUB_OAUTH_CLIENT_SECRET
 * - GITHUB_OAUTH_CALLBACK_URL
 * must be set, and the callback URL registered on the GitHub OAuth App.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { upsertGitHubConnection } from '@/lib/github/connection';
import { getGithubOAuthConfig, profileGithubRedirect } from '@/lib/github/oauth-config';
import {
  GITHUB_OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  verifyOAuthState,
} from '@/lib/github/oauth-state';

function finish(request: NextRequest, result: 'connected' | 'error') {
  const response = NextResponse.redirect(profileGithubRedirect(request.url, result));
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, '', { ...oauthStateCookieOptions(), maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  try {
    if (!verifyOAuthState(cookie, state) || !code) {
      return finish(request, 'error');
    }

    const user = await getSessionUser();
    if (!user) {
      return finish(request, 'error');
    }

    const { clientId, clientSecret, callbackUrl, configured } = getGithubOAuthConfig();
    if (!configured) {
      return finish(request, 'error');
    }

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return finish(request, 'error');
    }

    const ghUserRes = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenJson.access_token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const ghUser = (await ghUserRes.json().catch(() => ({}))) as {
      id?: number | string;
      login?: string;
    };
    if (!ghUserRes.ok || ghUser.id == null || !ghUser.login) {
      return finish(request, 'error');
    }

    await upsertGitHubConnection(prisma, {
      userId: user.id,
      githubUserId: String(ghUser.id),
      githubUsername: ghUser.login,
      accessToken: tokenJson.access_token,
      scope: tokenJson.scope || 'repo',
    });

    return finish(request, 'connected');
  } catch {
    return finish(request, 'error');
  }
}
