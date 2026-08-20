/**
 * GOVERNING RULE
 * A container filesystem is replaced on every deploy. A mounted volume survives
 * but is NOT backed up by DB backup and NOT replicated.
 *
 * Installation tokens cached under /data/cache are reconstructible from the GitHub App
 * (Integration secrets stay in Postgres). Safe to delete the cache at any time.
 *
 * They are stored encrypted with the same AES-256-GCM key as the rest of the credential
 * material. The volume sits outside the encrypted store and outside backups, and the cache
 * held a live org-write credential in cleartext for fifty minutes (F-234). Encrypting it
 * costs nothing: the argument for persisting the cache is GitHub's rate limit, and that
 * argument never required plaintext.
 */
import { createPrivateKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { prisma } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';
import { getIntegration } from '@/lib/integrations/store';
import { SECRETS_UNREADABLE_MESSAGE } from '@/lib/integrations/secrets';
import {
  DEFAULT_DEPLOY_BRANCH,
  DEFAULT_WORKSPACE_ID,
  GITHUB_APP_SETUP_MESSAGE,
} from '@/lib/publish/constants';
import { log } from '@/lib/logger';
import { readCacheJson, writeCacheJson } from '@/lib/runtime/data-dir';
import { assertPushableFiles, type PushFileEntry } from '@/lib/github/push-limits';

/**
 * Re-exported so publish assembly has one import for the push contract; the guards and the
 * limits themselves live in `lib/github/push-limits.ts`, which is a leaf (no prisma, no
 * fetch) so `publishJobErrorCode` can map the refusal without pulling this module in.
 */
export {
  assertPushableFiles,
  isBinaryPushEntry,
  MAX_PUSH_ENTRIES,
  MAX_PUSH_FILE_BYTES,
  MAX_PUSH_INLINE_BYTES,
  MAX_PUSH_TOTAL_BYTES,
  PushRefusedError,
  pushEntryByteLength,
  type PushFileEntry,
} from '@/lib/github/push-limits';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TOKEN_CACHE_MS = 50 * 60 * 1000;
const TOKEN_CACHE_FILE = 'github-tokens.json';
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** `token` is ciphertext on disk; the in-process map holds it decrypted. */
type TokenCacheFile = Record<string, { token: string; expiresAt: number }>;

function readPersistedToken(workspaceId: string) {
  const cached = tokenCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const file = readCacheJson<TokenCacheFile>(TOKEN_CACHE_FILE) ?? {};
  const row = file[workspaceId];
  if (!row || row.expiresAt <= Date.now()) return null;
  let token: string;
  try {
    token = decrypt(row.token);
  } catch (error) {
    // A rotated ENCRYPTION_KEY, or a cache file written before the tokens were encrypted.
    // Either way this entry is unusable; drop it and mint a fresh token.
    log.warn('github.token_cache_unreadable', {
      workspaceId,
      message:
        'The cached installation token could not be decrypted, so a new one is being minted.',
      error: error instanceof Error ? error.message : String(error),
    });
    clearInstallationTokenCache(workspaceId);
    return null;
  }
  tokenCache.set(workspaceId, { token, expiresAt: row.expiresAt });
  return token;
}

function persistToken(workspaceId: string, token: string, expiresAt: number) {
  tokenCache.set(workspaceId, { token, expiresAt });
  const file = readCacheJson<TokenCacheFile>(TOKEN_CACHE_FILE) ?? {};
  file[workspaceId] = { token: encrypt(token), expiresAt };
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

/**
 * Forgets the cached installation token for a workspace, in this process and on the volume.
 *
 * Nothing used to do this. When GitHub revoked a token mid-window — the App uninstalled, its
 * private key rotated — `readPersistedToken` kept serving the same rejected value for up to
 * fifty minutes, so publishes carried on failing with GitHub's own message long after the
 * operator had fixed the installation, with no way to force a refresh from the product
 * (F-234).
 */
export function clearInstallationTokenCache(workspaceId = DEFAULT_WORKSPACE_ID) {
  tokenCache.delete(workspaceId);
  const file = readCacheJson<TokenCacheFile>(TOKEN_CACHE_FILE) ?? {};
  if (!(workspaceId in file)) return;
  delete file[workspaceId];
  const written = writeCacheJson(TOKEN_CACHE_FILE, file);
  if (!written.ok) {
    log.warn('github.token_cache_clear_failed', {
      workspaceId,
      message:
        'A rejected installation token could not be removed from the volume cache. This process will not reuse it, but another instance may until it expires.',
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
  // A stored blob that will not decrypt is not a missing App. Reporting it as one told the
  // admin to "Connect GitHub" over a screen showing GitHub connected (F-212).
  if (row?.secretsUnreadable) {
    throw new GithubAppError(SECRETS_UNREADABLE_MESSAGE, 500);
  }
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
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
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

/**
 * The installation this workspace publishes as: its own `githubOrgInstallationId` when it
 * has one, otherwise the App's configured installation.
 *
 * The lookup used to be wrapped in a bare `catch` that returned the configured value with
 * nothing logged (F-250). Falling back is right — a database blip must not stop a publish —
 * but this is a credential-selection decision, so it has to be visible in the log when it
 * happens rather than inferred later from which installation the commits arrived under.
 */
export async function getInstallationId(workspaceId = DEFAULT_WORKSPACE_ID) {
  const creds = await requireAppCreds(workspaceId);
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubOrgInstallationId: true },
    });
    return workspace?.githubOrgInstallationId?.trim() || creds.installationId;
  } catch (error) {
    log.warn('github.installation_id_lookup_failed', {
      workspaceId,
      message:
        'The workspace row could not be read, so this publish authenticates as the App-wide installation.',
      error: error instanceof Error ? error.message : String(error),
    });
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

/**
 * A GitHub call made with the workspace's installation token, retried once on rejection.
 *
 * When GitHub answers 401 or 403 the token in hand is no longer usable — and, crucially, the
 * request did nothing, so retrying it is safe whatever its method. Nothing used to react to
 * that: the caller threw, the cache kept the rejected token, and every publish for the rest
 * of the fifty-minute window failed the same way (F-234). Now the entry is dropped and one
 * fresh token is minted before giving up, so an operator who reinstalls the App does not
 * have to wait out the cache.
 *
 * Every call in this module goes through here; a bare `githubJson` with an installation
 * token would reintroduce the stale-cache path.
 */
async function githubInstallationJson<T>(
  workspaceId: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const first = await githubJson<T>(await getInstallationToken(workspaceId), path, init);
  if (first.status !== 401 && first.status !== 403) return first;
  log.warn('github.installation_token_rejected', {
    workspaceId,
    status: first.status,
    path,
    message: 'GitHub rejected the cached installation token, so it was discarded and re-minted.',
  });
  clearInstallationTokenCache(workspaceId);
  return githubJson<T>(await getInstallationToken(workspaceId), path, init);
}

export async function deployOrg(workspaceId = DEFAULT_WORKSPACE_ID) {
  return (await requireAppCreds(workspaceId)).org;
}

/** What `ensureDeployRepo` / `getDeployRepo` learned about a deploy repo. */
export type DeployRepo = {
  fullName: string;
  /** GitHub's immutable numeric repository id, as a string — the ownership record. */
  repoId: string;
  /** True when this call created the repo. */
  created: boolean;
};

export async function ensureDeployRepo(
  slug: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<DeployRepo> {
  const org = await deployOrg(workspaceId);
  const fullName = `${org}/${slug}`;
  const existing = await githubInstallationJson<{
    id?: number;
    full_name?: string;
    message?: string;
  }>(workspaceId, `/repos/${fullName}`);
  if (existing.ok && existing.data.full_name && existing.data.id != null) {
    // Found by name only — whether this project may push here is the publish guard's
    // decision (`evaluateRepoGuard`), made from the id returned alongside.
    return { fullName: existing.data.full_name, repoId: String(existing.data.id), created: false };
  }
  if (existing.status !== 404) {
    throw new GithubAppError(
      existing.data.message || `Deploy repo check failed (${existing.status})`,
      existing.status,
      existing.data,
    );
  }
  const created = await githubInstallationJson<{
    id?: number;
    full_name?: string;
    message?: string;
  }>(workspaceId, `/orgs/${org}/repos`, {
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
  if (!created.ok || !created.data.full_name || created.data.id == null) {
    throw new GithubAppError(
      created.data.message || 'Could not create the deploy repo',
      created.status,
      created.data,
    );
  }
  return { fullName: created.data.full_name, repoId: String(created.data.id), created: true };
}

/**
 * One commit via the git trees API. Text files ride inline in the tree request (not one
 * blob call per file); binary files cannot — the inline `content` field is a JSON string
 * that GitHub reads as UTF-8, so a webp handed to it would be stored mangled. Those are
 * uploaded as base64 blobs first and referenced by sha.
 *
 * `assertPushableFiles` refuses an unpushable set *before* the ref read, so a site too
 * large for one commit fails with a sentence naming the files instead of whatever GitHub
 * answers after the bytes have been sent (F-261).
 *
 * `branch` is the branch Coolify is told to build. It used to be absent and the ref was
 * hardcoded to `main`, so a `Deployment.repoBranch` holding anything else would have had
 * Coolify deploying a branch this push never wrote (F-253).
 */
export async function pushFiles(
  repoFullName: string,
  files: Record<string, PushFileEntry>,
  message: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  branch = DEFAULT_DEPLOY_BRANCH,
) {
  const entries = Object.entries(files).filter(([path]) => path && !path.startsWith('.git/'));
  if (entries.length === 0) {
    throw new GithubAppError('No project files to push', 400);
  }
  assertPushableFiles(entries);

  const ref = await githubInstallationJson<{ object?: { sha?: string }; message?: string }>(
    workspaceId,
    `/repos/${repoFullName}/git/ref/heads/${branch}`,
  );
  // Could not look ≠ nothing there. `ref.ok ? … : undefined` sent a 403, a 500 and an
  // unexpected body into the "create the ref" branch, where GitHub answered "Reference
  // already exists" (422) — a sentence that reads like a product bug — after a parentless
  // commit had already been built and orphaned (F-251). Only 404 means the branch is absent.
  const parentSha = ref.ok ? ref.data.object?.sha : undefined;
  if (!ref.ok && ref.status !== 404) {
    throw new GithubAppError(
      `Could not read ${branch} in ${repoFullName}: ${ref.data.message || `GitHub returned ${ref.status}`}`,
      ref.status,
      ref.data,
    );
  }
  if (ref.ok && !parentSha) {
    throw new GithubAppError(
      `Could not read ${branch} in ${repoFullName}: GitHub returned no commit for the ref.`,
      ref.status,
      ref.data,
    );
  }

  // Blobs first, in path order: a tree entry can only carry a sha once the blob exists.
  // Sequential on purpose — a handful of assets per site, and a burst of parallel writes
  // is what GitHub's secondary rate limit is for.
  const tree: Array<Record<string, string>> = [];
  for (const [path, entry] of entries) {
    if (typeof entry === 'string') {
      tree.push({ path, mode: '100644', type: 'blob', content: entry });
      continue;
    }
    const blob = await githubInstallationJson<{ sha?: string; message?: string }>(
      workspaceId,
      `/repos/${repoFullName}/git/blobs`,
      { method: 'POST', body: JSON.stringify({ content: entry.base64, encoding: 'base64' }) },
    );
    if (!blob.ok || !blob.data.sha) {
      throw new GithubAppError(
        blob.data.message || `Could not upload ${path}`,
        blob.status,
        blob.data,
      );
    }
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const treeResult = await githubInstallationJson<{ sha?: string; message?: string }>(
    workspaceId,
    `/repos/${repoFullName}/git/trees`,
    { method: 'POST', body: JSON.stringify({ tree }) },
  );
  if (!treeResult.ok || !treeResult.data.sha) {
    throw new GithubAppError(
      treeResult.data.message || 'Could not create the git tree',
      treeResult.status,
      treeResult.data,
    );
  }

  const commit = await githubInstallationJson<{ sha?: string; message?: string }>(
    workspaceId,
    `/repos/${repoFullName}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: treeResult.data.sha,
        parents: parentSha ? [parentSha] : [],
      }),
    },
  );
  if (!commit.ok || !commit.data.sha) {
    throw new GithubAppError(
      commit.data.message || 'Could not create the git commit',
      commit.status,
      commit.data,
    );
  }

  if (parentSha) {
    const patched = await githubInstallationJson<{ message?: string }>(
      workspaceId,
      `/repos/${repoFullName}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.data.sha, force: true }),
      },
    );
    if (!patched.ok) {
      throw new GithubAppError(
        patched.data.message || `Could not update the ${branch} ref`,
        patched.status,
        patched.data,
      );
    }
  } else {
    const created = await githubInstallationJson<{ message?: string }>(
      workspaceId,
      `/repos/${repoFullName}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.data.sha }),
      },
    );
    if (!created.ok) {
      throw new GithubAppError(
        created.data.message || `Could not create the ${branch} ref`,
        created.status,
        created.data,
      );
    }
  }

  return commit.data.sha;
}

export async function deleteDeployRepo(repoFullName: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const result = await githubInstallationJson<{ message?: string }>(
    workspaceId,
    `/repos/${repoFullName}`,
    { method: 'DELETE' },
  );
  if (!result.ok && result.status !== 404) {
    throw new GithubAppError(
      result.data.message || 'Could not delete the deploy repo',
      result.status,
      result.data,
    );
  }
}

/** Archive rather than delete — deploy code is valuable. 404 = already gone. */
export async function archiveDeployRepo(repoFullName: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const result = await githubInstallationJson<{ message?: string }>(
    workspaceId,
    `/repos/${repoFullName}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    },
  );
  if (!result.ok && result.status !== 404) {
    throw new GithubAppError(
      result.data.message || 'Could not archive the deploy repo',
      result.status,
      result.data,
    );
  }
}

export async function getDeployRepo(
  repoFullName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<DeployRepo | null> {
  const existing = await githubInstallationJson<{
    id?: number;
    full_name?: string;
    message?: string;
  }>(workspaceId, `/repos/${repoFullName}`);
  if (existing.ok && existing.data.full_name && existing.data.id != null) {
    return { fullName: existing.data.full_name, repoId: String(existing.data.id), created: false };
  }
  if (existing.status === 404) return null;
  throw new GithubAppError(
    existing.data.message || `Deploy repo check failed (${existing.status})`,
    existing.status,
    existing.data,
  );
}

const REPOS_PER_PAGE = 100;
/** 100 pages × 100 = 10 000 repos. Past that the inventory is refused, not truncated. */
const REPO_PAGE_CAP = 100;

/**
 * Every repository in the deploy org, following GitHub's pagination to the end.
 *
 * It used to ask for one page of 100 and return it as the whole org — reached after a
 * hundred publishes — so the orphan cron silently saw a partial inventory it could not tell
 * from a complete one and reported "no orphans" while repos accumulated (F-233). A page that
 * fails, or an org past the cap, throws; the caller records a listing failure and refuses to
 * act on an inventory it could not read to the end.
 */
export async function listDeployRepos(workspaceId = DEFAULT_WORKSPACE_ID) {
  const org = await deployOrg(workspaceId);
  const rows: Array<{ full_name?: string; name?: string; created_at?: string }> = [];
  let complete = false;
  for (let page = 1; page <= REPO_PAGE_CAP; page += 1) {
    const result = await githubInstallationJson<
      Array<{ full_name?: string; name?: string; created_at?: string }>
    >(workspaceId, `/orgs/${org}/repos?per_page=${REPOS_PER_PAGE}&sort=created&page=${page}`);
    if (!result.ok) {
      throw new GithubAppError('Could not list deploy repos', result.status, result.data);
    }
    const batch = Array.isArray(result.data) ? result.data : [];
    rows.push(...batch);
    if (batch.length < REPOS_PER_PAGE) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new GithubAppError(
      `The organisation has more than ${REPO_PAGE_CAP * REPOS_PER_PAGE} repositories, so this inventory is incomplete.`,
      0,
      null,
    );
  }
  return rows
    .filter((row) => row.full_name || row.name)
    .map((row) => ({
      name: row.full_name || `${org}/${row.name}`,
      createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
    }));
}

/** One commit on a deploy branch. `pushFiles` writes exactly one per publish (F-210). */
export type DeployCommit = {
  sha: string;
  message: string;
  /** ISO-8601, or null when GitHub answered without a committer date. */
  committedAt: string | null;
};

/**
 * The deploy branch's commit history — one entry per publish, newest first.
 *
 * This is the release history the rollback picks from (F-264). There is no
 * deployment-history table: `Deployment.commitSha` only ever holds the current
 * release, and the deploy repo's log is the only record of the earlier ones.
 *
 * One page, no pagination: a rollback offers recent releases, and an operator who
 * wants a release older than `limit` publishes ago has the repo. A 404 (repo or
 * branch gone) is an empty history rather than a throw, so the caller can say
 * "no earlier release to roll back to" instead of surfacing a GitHub status.
 */
export async function listDeployCommits(
  repoFullName: string,
  branch = DEFAULT_DEPLOY_BRANCH,
  limit = 20,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<DeployCommit[]> {
  const result = await githubInstallationJson<
    Array<{ sha?: string; commit?: { message?: string; committer?: { date?: string } } }>
  >(
    workspaceId,
    `/repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
  );
  if (result.status === 404) return [];
  if (!result.ok) {
    throw new GithubAppError(
      `Could not read the release history of ${repoFullName} (${result.status})`,
      result.status,
      result.data,
    );
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows
    .filter(
      (row): row is { sha: string; commit?: { message?: string; committer?: { date?: string } } } =>
        typeof row.sha === 'string' && row.sha.length > 0,
    )
    .map((row) => ({
      sha: row.sha,
      message: row.commit?.message?.split('\n')[0] ?? '',
      committedAt: row.commit?.committer?.date ?? null,
    }));
}
