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

export function githubNewAppUrl(org: string | null | undefined, state: string) {
  const encoded = encodeURIComponent(state);
  const login = org?.trim().replace(/^@/, '');
  if (login) {
    return `https://github.com/organizations/${encodeURIComponent(login)}/settings/apps/new?state=${encoded}`;
  }
  return `https://github.com/settings/apps/new?state=${encoded}`;
}
