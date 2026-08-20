import { createPrivateKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { getIntegration, upsertIntegration } from './store';

const GITHUB_API = 'https://api.github.com';

async function appJwt(appId: string, pem: string) {
  const pkcs8 = createPrivateKey(pem.replace(/\\n/g, '\n').trim())
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 30)
    .setIssuer(appId)
    .setExpirationTime(now + 8 * 60)
    .sign(key);
}

export async function convertGithubManifest(code: string) {
  // Trusted host — do not route through safeFetch.
  const response = await fetch(
    `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = (await response.json().catch(() => ({}))) as {
    id?: number;
    slug?: string;
    html_url?: string;
    pem?: string;
    webhook_secret?: string;
    client_id?: string;
    client_secret?: string;
    message?: string;
  };
  if (!response.ok || !data.id || !data.pem) {
    throw new Error(data.message || 'Could not create the GitHub App');
  }
  return data;
}

export type GithubInstallationChoice = { id: string; accountLogin: string };

/**
 * Binds the integration to the App installation the operator asked for.
 *
 * The match is the requested installation id, else the configured org's login. There used to
 * be a third branch — `list[0]` — which then *overwrote* `org` and `accountLogin` with
 * whatever it found and marked the row CONNECTED. With the App installed on more than one
 * account (a personal account and the org, or an org that has since been renamed) publishing
 * silently bound to the wrong GitHub account and began creating, force-pushing to and
 * deleting repositories there, with the product's own record of `org` rewritten to match so
 * nothing looked wrong (F-235).
 *
 * With no explicit match the row stays PENDING and the installations are returned for the
 * admin to choose from. Guessing which account may be force-pushed to is not a decision this
 * function gets to make.
 */
export async function discoverGithubInstallation(input?: {
  workspaceId?: string;
  installationId?: string | null;
}) {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await getIntegration(workspaceId, 'GITHUB_DEPLOY');
  const appId = row?.config.appId ? String(row.config.appId) : '';
  const pem = row?.secrets.pem;
  if (!row || !appId || !pem) {
    return { found: false as const, reason: 'app-missing' as const, installations: [] };
  }

  const jwt = await appJwt(appId, pem);
  // Trusted host — do not route through safeFetch.
  const response = await fetch(`${GITHUB_API}/app/installations`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => [])) as Array<{
    id?: number;
    account?: { login?: string };
    repository_selection?: string;
  }>;
  const list = (Array.isArray(data) ? data : []).filter((item) => item.id != null);
  const installations: GithubInstallationChoice[] = list.map((item) => ({
    id: String(item.id),
    accountLogin: item.account?.login || '',
  }));
  const wanted = input?.installationId?.trim();
  const configuredOrg = row.config.org?.trim().toLowerCase();
  const match =
    (wanted && list.find((item) => String(item.id) === wanted)) ||
    (configuredOrg && list.find((item) => item.account?.login?.toLowerCase() === configuredOrg)) ||
    null;

  if (!match?.id) {
    return {
      found: false as const,
      reason: (installations.length > 0 ? 'ambiguous' : 'not-installed') as
        'ambiguous' | 'not-installed',
      installations,
    };
  }

  const updated = await upsertIntegration({
    workspaceId,
    kind: 'GITHUB_DEPLOY',
    status: 'CONNECTED',
    config: {
      ...row.config,
      installationId: String(match.id),
      accountLogin: match.account?.login || row.config.org,
      // F-270: `all` means this App's `contents:write` + `administration:write` reaches every
      // repository in the account. Recorded, not enforced — see GithubConfig.
      repositorySelection: match.repository_selection === 'selected' ? 'selected' : 'all',
      // `org` is only ever the account we matched *against*, never one we discovered.
      org: row.config.org || match.account?.login,
    },
    lastError: null,
  });
  return { found: true as const, integration: updated, installations };
}
