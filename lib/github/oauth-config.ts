import { getSettings } from '@/lib/settings/resolve';

/**
 * Credentials for GitHub account-linking (not login).
 *
 * These used to be readable only from the environment, which meant an operator
 * could not fix an unconfigured install from the product: the Connect button on
 * /connectors bounced straight back with a generic failure. They now resolve
 * from /admin/config first and fall back to the environment, so an existing
 * deployment keeps working untouched.
 */
export async function getGithubOAuthConfig() {
  const values = await getSettings([
    'github.oauth.clientId',
    'github.oauth.clientSecret',
    'github.oauth.callbackUrl',
  ]);
  const clientId = values['github.oauth.clientId'] ?? '';
  const clientSecret = values['github.oauth.clientSecret'] ?? '';
  const callbackUrl =
    values['github.oauth.callbackUrl'] ?? 'http://localhost:3000/api/github/callback';
  return {
    clientId,
    clientSecret,
    callbackUrl,
    configured: Boolean(clientId && clientSecret),
  };
}

export function profileGithubRedirect(
  requestUrl: string,
  result: 'connected' | 'error' | 'unconfigured',
) {
  return new URL(`/connectors?github=${result}`, requestUrl);
}
