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
  const response = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
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

export async function discoverGithubInstallation(input?: {
  workspaceId?: string;
  installationId?: string | null;
}) {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await getIntegration(workspaceId, 'GITHUB_DEPLOY');
  const appId = row?.config.appId ? String(row.config.appId) : '';
  const pem = row?.secrets.pem;
  if (!row || !appId || !pem) {
    return { found: false as const, reason: 'app-missing' };
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
  }>;
  const list = Array.isArray(data) ? data : [];
  const wanted = input?.installationId?.trim();
  const match =
    (wanted && list.find((item) => String(item.id) === wanted)) ||
    list.find((item) => item.account?.login?.toLowerCase() === row.config.org?.toLowerCase()) ||
    list[0];

  if (!match?.id) {
    return { found: false as const, reason: 'not-installed' };
  }

  const updated = await upsertIntegration({
    workspaceId,
    kind: 'GITHUB_DEPLOY',
    status: 'CONNECTED',
    config: {
      ...row.config,
      installationId: String(match.id),
      accountLogin: match.account?.login || row.config.org,
      org: match.account?.login || row.config.org,
    },
    lastError: null,
  });
  return { found: true as const, integration: updated };
}
