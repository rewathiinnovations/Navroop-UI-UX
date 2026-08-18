import type { GithubManifest } from './types';

export function appUrl() {
  return (
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

export function githubManifest(input: {
  workspaceName: string;
  appUrl: string;
  org?: string;
}): GithubManifest {
  const base = input.appUrl.replace(/\/+$/, '');
  return {
    name: `Navroop Deploy — ${input.workspaceName}`.slice(0, 34),
    url: base,
    redirect_url: `${base}/api/integrations/github/callback`,
    setup_url: `${base}/api/integrations/github/installed`,
    public: false,
    default_permissions: {
      contents: 'write',
      administration: 'write',
      metadata: 'read',
    },
    default_events: [],
  };
}

/**
 * Manifest for the *connectors* GitHub app — the one whose client id/secret
 * fill Admin → Configuration → Connectors so members can link their own
 * accounts. Distinct from the deploy app: least privilege (no administration),
 * no setup page, and its callback saves settings instead of an Integration.
 */
export function githubConnectorsManifest(input: {
  workspaceName: string;
  appUrl: string;
}): GithubManifest {
  const base = input.appUrl.replace(/\/+$/, '');
  return {
    name: `Navroop Connect — ${input.workspaceName}`.slice(0, 34),
    url: base,
    redirect_url: `${base}/api/admin/settings/github-app/callback`,
    // Without a registered OAuth callback, GitHub refuses user authorization
    // with "This GitHub App must be configured with a callback URL". This is
    // the same URL the Connect flow exchanges the code on.
    callback_urls: [`${base}/api/github/callback`],
    public: false,
    default_permissions: {
      contents: 'write',
      metadata: 'read',
      // Repo creation (POST /user/repos) with a user-to-server token requires
      // Administration write on the app — without it every push fails with
      // GitHub's "Resource not accessible by integration".
      administration: 'write',
    },
    default_events: [],
  };
}

export function githubNewAppUrl(org: string | null | undefined, state: string) {
  const encoded = encodeURIComponent(state);
  const login = org?.trim().replace(/^@/, '');
  if (login) {
    return `https://github.com/organizations/${encodeURIComponent(login)}/settings/apps/new?state=${encoded}`;
  }
  return `https://github.com/settings/apps/new?state=${encoded}`;
}
