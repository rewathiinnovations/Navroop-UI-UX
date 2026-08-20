import { GITHUB_WEBHOOK_EVENTS, GITHUB_WEBHOOK_ROUTE } from './github-webhook';
import type { GithubManifest } from './types';

/**
 * The public origin is not read here any more. `appUrl()` used to live in this
 * file reading `process.env.APP_URL`, so the manifest sent to GitHub and the
 * `github.oauth.callbackUrl` saved by the one-click setup kept the old origin
 * after an operator changed Application URL on /admin/config — the app then
 * installed and never called back. Callers pass `await appPublicUrl()` from
 * `@/lib/settings/app-url`, which resolves the setting before the environment.
 */

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
    // `contents: write` pushes the generated site; `administration: write` is what
    // `POST /user/repos` needs to create the repository at all — GitHub answers "Resource not
    // accessible by integration" without it. A manifest cannot request an installation
    // *scope*, only permissions: whether those permissions reach one repository or every
    // repository in the account is chosen by the operator on GitHub's install screen. That is
    // the only control that bounds this App, so /admin/integrations tells the operator to
    // pick "Only select repositories" before installing and reports `repository_selection`
    // afterwards (F-270). Do not widen this set; F-202 was a force-push over an unrelated
    // repository, and these two permissions are its blast radius.
    default_permissions: {
      contents: 'write',
      administration: 'write',
      metadata: 'read',
    },
    // F-265: the App's webhook_secret used to be stored and never used, because nothing
    // subscribed and no route existed. Subscribing here is what gives the secret — and the
    // signature check in `app/api/integrations/github/webhook` — something to verify.
    hook_attributes: { url: `${base}${GITHUB_WEBHOOK_ROUTE}`, active: true },
    default_events: [...GITHUB_WEBHOOK_EVENTS],
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
