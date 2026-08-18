export type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function githubJson<T>(
  githubFetch: GithubFetch,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T; raw: string }> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await githubFetch(url, { ...init, headers });
  const raw = await res.text();
  let data = {} as T;
  if (raw) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = {} as T;
    }
  }
  return { ok: res.ok, status: res.status, data, raw };
}

export async function createPrivateRepo(
  githubFetch: GithubFetch,
  token: string,
  name: string,
) {
  const result = await githubJson<{ full_name?: string; html_url?: string; message?: string }>(
    githubFetch,
    token,
    'https://api.github.com/user/repos',
    {
      method: 'POST',
      // auto_init: the git-data API cannot create trees in a repo with zero
      // commits (409 "Git Repository is empty."), so a new repo must be born
      // with an initial commit for the first push to have a parent.
      body: JSON.stringify({ name, private: true, auto_init: true }),
    },
  );
  if (!result.ok || !result.data.full_name || !result.data.html_url) {
    throw new Error(result.data.message || 'Could not create GitHub repository');
  }
  return { fullName: result.data.full_name, htmlUrl: result.data.html_url };
}

export async function pushViaGitDataApi(input: {
  githubFetch: GithubFetch;
  token: string;
  fullName: string;
  files: Record<string, string>;
}) {
  const { githubFetch, token, fullName, files } = input;
  const base = `https://api.github.com/repos/${fullName}`;

  const entries = Object.entries(files).filter(([path]) => path && !path.startsWith('.git/'));
  if (entries.length === 0) {
    throw new Error('No project files to push');
  }

  let ref = await githubJson<{ object?: { sha?: string }; message?: string }>(
    githubFetch,
    token,
    `${base}/git/ref/heads/main`,
  );
  if (!ref.ok && /repository is empty/i.test(ref.data.message || '')) {
    // Repos created before auto_init (or emptied by hand) have no commits, and
    // tree creation 409s on them. The Contents API is the one endpoint that
    // can write to an empty repo, so seed the initial commit through it.
    const seeded = await githubJson<{ message?: string }>(
      githubFetch,
      token,
      `${base}/contents/README.md`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Initialize repository',
          content: Buffer.from(`# ${fullName.split('/').pop()}
`).toString('base64'),
        }),
      },
    );
    if (!seeded.ok) {
      throw new Error(seeded.data.message || 'Could not initialize the empty repository');
    }
    ref = await githubJson<{ object?: { sha?: string }; message?: string }>(
      githubFetch,
      token,
      `${base}/git/ref/heads/main`,
    );
  }
  const parentSha = ref.ok ? ref.data.object?.sha : undefined;

  const treeItems: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const [path, content] of entries) {
    const blob = await githubJson<{ sha?: string; message?: string }>(
      githubFetch,
      token,
      `${base}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'utf-8' }),
      },
    );
    if (!blob.ok || !blob.data.sha) {
      throw new Error(blob.data.message || `Could not create blob for ${path}`);
    }
    treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const tree = await githubJson<{ sha?: string; message?: string }>(
    githubFetch,
    token,
    `${base}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({ tree: treeItems }),
    },
  );
  if (!tree.ok || !tree.data.sha) {
    throw new Error(tree.data.message || 'Could not create git tree');
  }

  const commit = await githubJson<{ sha?: string; message?: string }>(
    githubFetch,
    token,
    `${base}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: 'Push from Navroop',
        tree: tree.data.sha,
        parents: parentSha ? [parentSha] : [],
      }),
    },
  );
  if (!commit.ok || !commit.data.sha) {
    throw new Error(commit.data.message || 'Could not create git commit');
  }

  if (parentSha) {
    const patched = await githubJson<{ message?: string }>(
      githubFetch,
      token,
      `${base}/git/refs/heads/main`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.data.sha, force: true }),
      },
    );
    if (!patched.ok) {
      throw new Error(patched.data.message || 'Could not update main ref');
    }
  } else {
    const created = await githubJson<{ message?: string }>(
      githubFetch,
      token,
      `${base}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.data.sha }),
      },
    );
    if (!created.ok) {
      throw new Error(created.data.message || 'Could not create main ref');
    }
  }

  return { commitSha: commit.data.sha };
}
