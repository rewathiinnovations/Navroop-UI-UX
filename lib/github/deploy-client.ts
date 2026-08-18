/**
 * GOVERNING RULE
 * A container filesystem is replaced on every deploy. A mounted volume survives
 * but is NOT backed up by DB backup and NOT replicated.
 *
 * Installation tokens cached under /data/cache are reconstructible from the GitHub App
 * (Integration secrets stay in Postgres). Safe to delete the cache at any time.
 */
import { createPrivateKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { prisma } from '@/lib/db';
import { getIntegration } from '@/lib/integrations/store';
import { DEFAULT_WORKSPACE_ID, GITHUB_APP_SETUP_MESSAGE } from '@/lib/publish/constants';
import { log } from '@/lib/logger';
import { readCacheJson, writeCacheJson } from '@/lib/runtime/data-dir';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TOKEN_CACHE_MS = 50 * 60 * 1000;
const TOKEN_CACHE_FILE = 'github-tokens.json';
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

type TokenCacheFile = Record<string, { token: string; expiresAt: number }>;

function readPersistedToken(workspaceId: string) {
  const cached = tokenCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const file = readCacheJson<TokenCacheFile>(TOKEN_CACHE_FILE) ?? {};
  const row = file[workspaceId];
  if (row && row.expiresAt > Date.now()) {
    tokenCache.set(workspaceId, row);
    return row.token;
  }
  return null;
}

function persistToken(workspaceId: string, token: string, expiresAt: number) {
  tokenCache.set(workspaceId, { token, expiresAt });
  const file = readCacheJson<TokenCacheFile>(TOKEN_CACHE_FILE) ?? {};
  file[workspaceId] = { token, expiresAt };
  // `readCacheJson` and `writeCacheJson` both swallow their own I/O errors, so the old
  // try/catch here was a second layer of silence around code that cannot throw. The cache is
  // still optional — the in-process map holds the token — but a persistent failure means
  // every deploy re-mints an installation token against the GitHub rate limit, so say so.
  const written = writeCacheJson(TOKEN_CACHE_FILE, file);
  if (!written.ok) {
    log.warn('github.token_cache_write_failed', {
      workspaceId,
      message: 'Installation tokens are not being cached, so each publish will mint a new one.',
      error: written.error,
    });
  }
}

export class GithubAppError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status = 500, body: unknown = null) {
    super(message);
    this.name = 'GithubAppError';
    this.status = status;
    this.body = body;
  }
}

async function requireAppCreds(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await getIntegration(workspaceId, 'GITHUB_DEPLOY');
  const appId = row?.config.appId != null ? String(row.config.appId) : '';
  const privateKey = row?.secrets.pem?.trim() || '';
  const installationId = row?.config.installationId?.trim() || '';
  const org = (row?.config.org || row?.config.accountLogin || '').trim();
  if (row?.status !== 'CONNECTED' || !appId || !privateKey || !installationId || !org) {
    throw new GithubAppError(GITHUB_APP_SETUP_MESSAGE, 500);
  }
  return { appId, privateKey, installationId, org };
}

function normalizePem(raw: string) {
  return raw.replace(/\\n/g, '\n').trim();
}

async function appJwt(workspaceId = DEFAULT_WORKSPACE_ID) {
  const { appId, privateKey } = await requireAppCreds(workspaceId);
  const pem = normalizePem(privateKey);
  const pkcs8 = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 30)
    .setIssuer(appId)
    .setExpirationTime(now + 8 * 60)
    .sign(key);
}

async function githubJson<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-GitHub-Api-Version', API_VERSION);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Trusted host — do not route through safeFetch.
  const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const raw = await response.text();
  let data = {} as T;
  if (raw) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = {} as T;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

export async function getInstallationId(workspaceId = DEFAULT_WORKSPACE_ID) {
  const creds = await requireAppCreds(workspaceId);
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubOrgInstallationId: true },
    });
    return workspace?.githubOrgInstallationId?.trim() || creds.installationId;
  } catch {
    return creds.installationId;
  }
}

/** Short-lived GitHub App installation token. Never falls back to personal OAuth. */
export async function getInstallationToken(workspaceId = DEFAULT_WORKSPACE_ID) {
  const cached = readPersistedToken(workspaceId);
  if (cached) return cached;
  const jwt = await appJwt(workspaceId);
  const installationId = await getInstallationId(workspaceId);
  const result = await githubJson<{ token?: string; message?: string }>(
    jwt,
    `/app/installations/${installationId}/access_tokens`,
    { method: 'POST' },
  );
  if (!result.ok || !result.data.token) {
    throw new GithubAppError(
      result.data.message || 'GitHub App installation token was not found',
      result.status,
      result.data,
    );
  }
  persistToken(workspaceId, result.data.token, Date.now() + TOKEN_CACHE_MS);
  return result.data.token;
}

export async function deployOrg(workspaceId = DEFAULT_WORKSPACE_ID) {
  return (await requireAppCreds(workspaceId)).org;
}

export async function ensureDeployRepo(slug: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const org = await deployOrg(workspaceId);
  const token = await getInstallationToken(workspaceId);
  const fullName = `${org}/${slug}`;
  const existing = await githubJson<{ full_name?: string; message?: string }>(token, `/repos/${fullName}`);
  if (existing.ok && existing.data.full_name) {
    return existing.data.full_name;
  }
  if (existing.status !== 404) {
    throw new GithubAppError(
      existing.data.message || `Deploy repo check failed (${existing.status})`,
      existing.status,
      existing.data,
    );
  }
  const created = await githubJson<{ full_name?: string; message?: string }>(token, `/orgs/${org}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: slug,
      private: true,
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    }),
  });
  if (!created.ok || !created.data.full_name) {
    throw new GithubAppError(
      created.data.message || 'Could not create the deploy repo',
      created.status,
      created.data,
    );
  }
  return created.data.full_name;
}

/**
 * One commit via the git trees API with inline file content (not one blob call per file).
 */
export async function pushFiles(
  repoFullName: string,
  files: Record<string, string>,
  message: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
) {
  const token = await getInstallationToken(workspaceId);
  const entries = Object.entries(files).filter(([path]) => path && !path.startsWith('.git/'));
  if (entries.length === 0) {
    throw new GithubAppError('No project files to push', 400);
  }

  const ref = await githubJson<{ object?: { sha?: string } }>(token, `/repos/${repoFullName}/git/ref/heads/main`);
  const parentSha = ref.ok ? ref.data.object?.sha : undefined;

  const tree = await githubJson<{ sha?: string; message?: string }>(token, `/repos/${repoFullName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      tree: entries.map(([path, content]) => ({
        path,
        mode: '100644',
        type: 'blob',
        content,
      })),
    }),
  });
  if (!tree.ok || !tree.data.sha) {
    throw new GithubAppError(tree.data.message || 'Could not create the git tree', tree.status, tree.data);
  }

  const commit = await githubJson<{ sha?: string; message?: string }>(token, `/repos/${repoFullName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.data.sha,
      parents: parentSha ? [parentSha] : [],
    }),
  });
  if (!commit.ok || !commit.data.sha) {
    throw new GithubAppError(commit.data.message || 'Could not create the git commit', commit.status, commit.data);
  }

  if (parentSha) {
    const patched = await githubJson<{ message?: string }>(token, `/repos/${repoFullName}/git/refs/heads/main`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.data.sha, force: true }),
    });
    if (!patched.ok) {
      throw new GithubAppError(patched.data.message || 'Could not update the main ref', patched.status, patched.data);
    }
  } else {
    const created = await githubJson<{ message?: string }>(token, `/repos/${repoFullName}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.data.sha }),
    });
    if (!created.ok) {
      throw new GithubAppError(created.data.message || 'Could not create the main ref', created.status, created.data);
    }
  }

  return commit.data.sha;
}

export async function deleteDeployRepo(repoFullName: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const token = await getInstallationToken(workspaceId);
  const result = await githubJson<{ message?: string }>(token, `/repos/${repoFullName}`, { method: 'DELETE' });
  if (!result.ok && result.status !== 404) {
    throw new GithubAppError(result.data.message || 'Could not delete the deploy repo', result.status, result.data);
  }
}

/** Archive rather than delete — deploy code is valuable. 404 = already gone. */
export async function archiveDeployRepo(repoFullName: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const token = await getInstallationToken(workspaceId);
  const result = await githubJson<{ message?: string }>(token, `/repos/${repoFullName}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  if (!result.ok && result.status !== 404) {
    throw new GithubAppError(result.data.message || 'Could not archive the deploy repo', result.status, result.data);
  }
}

export async function getDeployRepo(repoFullName: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const token = await getInstallationToken(workspaceId);
  const existing = await githubJson<{ full_name?: string; message?: string }>(token, `/repos/${repoFullName}`);
  if (existing.ok && existing.data.full_name) return existing.data.full_name;
  if (existing.status === 404) return null;
  throw new GithubAppError(
    existing.data.message || `Deploy repo check failed (${existing.status})`,
    existing.status,
    existing.data,
  );
}

export async function listDeployRepos(workspaceId = DEFAULT_WORKSPACE_ID) {
  const org = await deployOrg(workspaceId);
  const token = await getInstallationToken(workspaceId);
  const result = await githubJson<Array<{ full_name?: string; name?: string; created_at?: string }>>(
    token,
    `/orgs/${org}/repos?per_page=100&sort=created`,
  );
  if (!result.ok) {
    throw new GithubAppError('Could not list deploy repos', result.status, result.data);
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows
    .filter((row) => row.full_name || row.name)
    .map((row) => ({
      name: row.full_name || `${org}/${row.name}`,
      createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
    }));
}
