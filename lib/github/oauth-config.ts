export function getGithubOAuthConfig() {
  const clientId = String(process.env.GITHUB_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GITHUB_OAUTH_CLIENT_SECRET || '').trim();
  const callbackUrl = String(
    process.env.GITHUB_OAUTH_CALLBACK_URL || 'http://localhost:3000/api/github/callback',
  ).trim();
  return {
    clientId,
    clientSecret,
    callbackUrl,
    configured: Boolean(clientId && clientSecret),
  };
}

export function profileGithubRedirect(requestUrl: string, result: 'connected' | 'error') {
  return new URL(`/connectors?github=${result}`, requestUrl);
}
