import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two silent decisions in the GitHub App deploy client.
 *
 * F-250: `getInstallationId` wrapped the workspace lookup for `githubOrgInstallationId` in
 * `try { … } catch { return creds.installationId }` with nothing logged. A database problem
 * quietly changed which GitHub installation the publish authenticated as. The fallback is
 * the right behaviour; being unable to see it happen is not, because it is a
 * credential-selection decision.
 *
 * F-251: `parentSha = ref.ok ? … : undefined`. Reading `refs/heads/<branch>` can fail for
 * reasons other than "the branch is not there" — 403, 500, an unexpected body — and every
 * one of them routed into the "create the ref" branch. The create then failed with GitHub's
 * "Reference already exists" (422), which reads like a product bug rather than "we could not
 * read the branch", and in the worst case a parentless commit was built and discarded. Could
 * not look ≠ nothing there: only 404 means absent.
 *
 * Goes red if the ref read starts treating a non-404 as absent, if an ok response with no
 * sha is accepted as absent, or if the installation fallback goes quiet again.
 */

const dataDir = vi.hoisted(() => ({ readCacheJson: vi.fn(), writeCacheJson: vi.fn() }));
const store = vi.hoisted(() => ({ getIntegration: vi.fn() }));
const db = vi.hoisted(() => ({ prisma: { workspace: { findUnique: vi.fn() } } }));

vi.mock('@/lib/runtime/data-dir', () => dataDir);
vi.mock('@/lib/integrations/store', () => store);
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
}));

const { log } = await import('@/lib/logger');
const { getInstallationId, pushFiles, GithubAppError } =
  await import('@/lib/github/deploy-client.ts');

const CONNECTED = {
  status: 'CONNECTED',
  config: { appId: '1', installationId: 'inst-from-app', org: 'deploy-org' },
  secrets: { pem: 'unused-because-the-token-cache-is-warm' },
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();
/** Structured warn entries recorded during a case: `[event, fields]`. */
const warnings: Array<{ event: string; fields: unknown }> = [];

/** Answers the ref read with `ref`, and everything else the way GitHub would on success. */
function repoWhereRefReadReturns(ref: { status: number; body: unknown }) {
  const calls: Call[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (method === 'GET' && url.includes('/git/ref/heads/')) {
      return Promise.resolve(json(ref.status, ref.body));
    }
    if (method === 'POST' && url.includes('/git/trees')) {
      return Promise.resolve(json(201, { sha: 'tree1' }));
    }
    if (method === 'POST' && url.includes('/git/commits')) {
      return Promise.resolve(json(201, { sha: 'commit1' }));
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      return Promise.resolve(json(201, { ref: 'refs/heads/main' }));
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) {
      return Promise.resolve(json(200, {}));
    }
    return Promise.resolve(json(404, { message: `unhandled ${method} ${url}` }));
  });
  return calls;
}

function push(branch?: string) {
  return pushFiles(
    'deploy-org/acme',
    { 'index.html': '<h1>Hi</h1>' },
    'Publish live acme',
    'default',
    branch,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  warnings.length = 0;
  vi.spyOn(log, 'warn').mockImplementation((event, fields) => {
    warnings.push({ event, fields });
  });
  dataDir.readCacheJson.mockReset();
  // A fresh object per call: `clearInstallationTokenCache` mutates what it reads, and a
  // shared literal would let one case's cache clear starve every later read.
  dataDir.readCacheJson.mockImplementation(() => ({
    default: { token: 'installation-token', expiresAt: Date.now() + 3_600_000 },
  }));
  dataDir.writeCacheJson.mockReset();
  dataDir.writeCacheJson.mockReturnValue({ ok: true });
  store.getIntegration.mockReset();
  store.getIntegration.mockResolvedValue(CONNECTED);
  db.prisma.workspace.findUnique.mockReset();
  db.prisma.workspace.findUnique.mockResolvedValue({ githubOrgInstallationId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getInstallationId', () => {
  it('logs the workspace whose lookup failed before falling back to the App config', async () => {
    db.prisma.workspace.findUnique.mockRejectedValue(new Error('connection terminated'));

    await expect(getInstallationId('ws-7')).resolves.toBe('inst-from-app');

    const entry = warnings.find((row) => row.event.includes('installation'));
    expect(entry).toBeDefined();
    expect(entry?.fields).toMatchObject({ workspaceId: 'ws-7' });
    expect(JSON.stringify(entry?.fields)).toContain('connection terminated');
  });

  it('says nothing when the lookup works', async () => {
    db.prisma.workspace.findUnique.mockResolvedValue({ githubOrgInstallationId: 'inst-override' });

    await expect(getInstallationId('ws-7')).resolves.toBe('inst-override');

    expect(warnings.filter((row) => row.event.includes('installation'))).toEqual([]);
  });
});

describe('pushFiles ref read', () => {
  it('creates the ref when GitHub says 404 — that is the branch really being absent', async () => {
    const calls = repoWhereRefReadReturns({ status: 404, body: { message: 'Not Found' } });

    await expect(push()).resolves.toBe('commit1');

    const commit = calls.find((call) => call.url.includes('/git/commits'));
    expect(commit?.body?.parents).toEqual([]);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/git/refs'))).toBe(
      true,
    );
  });

  it('refuses on a 500 instead of trying to create a ref that may already exist', async () => {
    const calls = repoWhereRefReadReturns({ status: 500, body: { message: 'Server Error' } });

    const error = await push().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GithubAppError);
    expect((error as Error).message).toMatch(/could not read/i);
    expect((error as Error).message).toMatch(/main/);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/git/refs'))).toBe(
      false,
    );
  });

  it('refuses on a 403 the retry could not clear', async () => {
    repoWhereRefReadReturns({ status: 403, body: { message: 'Resource not accessible' } });

    await expect(push()).rejects.toBeInstanceOf(GithubAppError);
  });

  it('refuses when the read succeeded but carried no sha', async () => {
    const calls = repoWhereRefReadReturns({ status: 200, body: { object: {} } });

    await expect(push()).rejects.toThrow(/could not read/i);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/git/refs'))).toBe(
      false,
    );
  });

  it('reads and writes the branch it was given, not a hardcoded main', async () => {
    const calls = repoWhereRefReadReturns({ status: 200, body: { object: { sha: 'head1' } } });

    await expect(push('release')).resolves.toBe('commit1');

    expect(calls.some((call) => call.url.includes('/git/ref/heads/release'))).toBe(true);
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toContain('/git/refs/heads/release');
    expect(calls.some((call) => call.url.includes('heads/main'))).toBe(false);
  });
});
