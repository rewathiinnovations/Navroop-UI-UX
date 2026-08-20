import { describe, expect, it } from 'vitest';
import { pushViaGitDataApi, RepoMovedUpstreamError, type GithubFetch } from '@/lib/github/git-data';

/**
 * F-210: the Connectors push targets the user's OWN repository
 * (`Project.githubRepoFullName`). It used to build a root tree (no `base_tree`)
 * and move `main` with `force: true`, silently deleting everything the user
 * added themselves. The contract now is: a child commit over the current head,
 * a non-force ref update that fails when the remote moved (compare-and-swap),
 * and full-replace semantics only behind an explicit `force: true` opt-in.
 */

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Call = { method: string; url: string; body: Record<string, unknown> | null };

type FakeRepo = { calls: Call[]; fetcher: GithubFetch };

function fakeRepo(
  input: { head?: { sha: string; treeSha: string } | null; refMoved?: boolean } = {},
): FakeRepo {
  const head = input.head === undefined ? { sha: 'head1', treeSha: 'headtree1' } : input.head;
  const calls: Call[] = [];
  const fetcher: GithubFetch = async (url, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });

    if (method === 'GET' && url.includes('/git/ref/heads/main')) {
      return head ? json(200, { object: { sha: head.sha } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && head && url.includes(`/git/commits/${head.sha}`)) {
      return json(200, { sha: head.sha, tree: { sha: head.treeSha } });
    }
    if (method === 'POST' && url.includes('/git/blobs')) {
      return json(201, { sha: `blob${calls.length}` });
    }
    if (method === 'POST' && url.includes('/git/trees')) {
      return json(201, { sha: 'tree9' });
    }
    if (method === 'POST' && url.includes('/git/commits')) {
      return json(201, { sha: 'commit9' });
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/main')) {
      if (input.refMoved) return json(422, { message: 'Update is not a fast forward' });
      return json(200, { object: { sha: body?.sha } });
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      return json(201, { ref: 'refs/heads/main' });
    }
    return json(404, { message: `unhandled ${method} ${url}` });
  };
  return { calls, fetcher };
}

function push(repo: FakeRepo, force?: boolean) {
  return pushViaGitDataApi({
    githubFetch: repo.fetcher,
    token: 'test-key',
    fullName: 'octocat/site',
    files: { 'index.html': '<h1>Hi</h1>' },
    ...(force === undefined ? {} : { force }),
  });
}

describe('pushViaGitDataApi', () => {
  it('commits a delta child of the current head and never forces the ref', async () => {
    const repo = fakeRepo();
    await expect(push(repo)).resolves.toEqual({ commitSha: 'commit9' });

    const tree = repo.calls.find((c) => c.method === 'POST' && c.url.includes('/git/trees'));
    expect(tree?.body?.base_tree).toBe('headtree1');

    const commit = repo.calls.find((c) => c.method === 'POST' && c.url.includes('/git/commits'));
    expect(commit?.body?.parents).toEqual(['head1']);

    const patch = repo.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.body?.force).toBe(false);
  });

  it('refuses with a typed error when the remote moved between read and write', async () => {
    const repo = fakeRepo({ refMoved: true });
    const error = await push(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoMovedUpstreamError);
    expect((error as Error).message).toMatch(/changed upstream/i);
  });

  it('replaces the tree and forces the ref only behind the explicit force opt-in', async () => {
    const repo = fakeRepo();
    await expect(push(repo, true)).resolves.toEqual({ commitSha: 'commit9' });

    const tree = repo.calls.find((c) => c.method === 'POST' && c.url.includes('/git/trees'));
    expect(tree?.body).not.toHaveProperty('base_tree');

    const patch = repo.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body?.force).toBe(true);
  });

  it('creates a root commit via ref create when the repo has no main yet', async () => {
    const repo = fakeRepo({ head: null });
    await expect(push(repo)).resolves.toEqual({ commitSha: 'commit9' });

    const tree = repo.calls.find((c) => c.method === 'POST' && c.url.includes('/git/trees'));
    expect(tree?.body).not.toHaveProperty('base_tree');

    const commit = repo.calls.find((c) => c.method === 'POST' && c.url.includes('/git/commits'));
    expect(commit?.body?.parents).toEqual([]);

    expect(repo.calls.some((c) => c.method === 'PATCH')).toBe(false);
    const created = repo.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'));
    expect(created?.body?.ref).toBe('refs/heads/main');
  });
});
