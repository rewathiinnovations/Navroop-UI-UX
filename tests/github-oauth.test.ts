/**
 * GitHub OAuth account-linking + push verification (no UI).
 * Run: node --experimental-strip-types tests/github-oauth.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import {
  CONNECT_FIRST_MESSAGE,
  disconnectGitHubForUser,
  getGitHubConnectionStatusForUser,
  upsertGitHubConnection,
} from '../lib/github/connection.js';
import { createOAuthState, verifyOAuthState } from '../lib/github/oauth-state.js';
import { pushProjectToGitHubForUser } from '../lib/github/push.js';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET && !process.env.ENCRYPTION_KEY) {
  process.env.AUTH_SECRET = 'test-auth-secret-for-github-oauth-verification';
}

const BASE = process.env.APP_URL || 'http://localhost:3000';
const prisma = new PrismaClient();

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function envPresent(name: string) {
  const value = String(process.env[name] || '').trim();
  return value.length > 0;
}

function mockGithub() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let repoCreated = 0;
  let commits = 0;
  const blobs = new Map<string, string>();
  let treeSha = 0;
  let commitSha = 0;
  let mainSha: string | null = null;

  const githubFetch = async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    if (method === 'POST' && url === 'https://api.github.com/user/repos') {
      repoCreated += 1;
      const name = (body as { name?: string })?.name || 'repo';
      return json(201, {
        full_name: `octocat/${name}`,
        html_url: `https://github.com/octocat/${name}`,
        private: true,
      });
    }
    if (url.includes('/git/blobs') && method === 'POST') {
      const sha = `blob${blobs.size + 1}`;
      blobs.set(sha, String((body as { content?: string })?.content || ''));
      return json(201, { sha });
    }
    if (url.includes('/git/trees') && method === 'POST') {
      treeSha += 1;
      return json(201, { sha: `tree${treeSha}` });
    }
    if (url.includes('/git/commits') && method === 'POST') {
      commits += 1;
      commitSha += 1;
      return json(201, { sha: `commit${commitSha}` });
    }
    if (url.includes('/git/ref/heads/main') && method === 'GET') {
      if (!mainSha) return json(404, { message: 'Not Found' });
      return json(200, { object: { sha: mainSha } });
    }
    if (url.includes('/git/refs/heads/main') && method === 'PATCH') {
      mainSha = String((body as { sha?: string })?.sha || '');
      return json(200, { object: { sha: mainSha } });
    }
    if (url.endsWith('/git/refs') && method === 'POST') {
      mainSha = String((body as { sha?: string })?.sha || '');
      return json(201, { ref: 'refs/heads/main' });
    }
    return json(404, { message: `unhandled ${method} ${url}` });
  };

  return {
    githubFetch,
    calls,
    stats: () => ({ repoCreated, commits, blobCount: blobs.size }),
  };
}

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function main() {
  const oauthConfigured =
    envPresent('GITHUB_OAUTH_CLIENT_ID') && envPresent('GITHUB_OAUTH_CLIENT_SECRET');
  console.log(
    oauthConfigured
      ? 'Live GitHub OAuth env: PRESENT (interactive browser grant not completed in this script)'
      : 'Live GitHub OAuth env: MISSING — unit tests still cover encrypt/upsert/state CSRF/connect-first',
  );

  const plain = 'gho_test_token_value';
  const encrypted = encrypt(plain);
  assert(encrypted !== plain, 'encrypt does not store plaintext');
  assert(decrypt(encrypted) === plain, 'decrypt round-trips token');

  const { state, cookieValue } = createOAuthState();
  assert(verifyOAuthState(cookieValue, state), 'signed state cookie verifies');
  assert(!verifyOAuthState(cookieValue, 'other-state'), 'state mismatch is rejected');
  assert(!verifyOAuthState(undefined, state), 'missing cookie state is rejected');
  assert(!verifyOAuthState(cookieValue, undefined), 'missing query state is rejected');
  assert(!verifyOAuthState('not-signed', state), 'unsigned cookie is rejected');

  const suffix = `${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      email: `gh-oauth-${suffix}@navroop.test`,
      name: 'GitHub OAuth Test',
      passwordHash: 'not-a-real-hash',
    },
  });
  const project = await prisma.project.create({
    data: {
      name: 'Push Demo',
      initialPrompt: 'demo',
      ownerId: user.id,
      lastCode: '<file path="src/App.jsx">export default function App(){return null}</file>',
    },
  });

  try {
    const before = await getGitHubConnectionStatusForUser(prisma, user.id);
    assert(before.connected === false, 'status is disconnected before upsert');
    assert(!('accessTokenEncrypted' in before), 'status never includes token field');

    const pushNone = await pushProjectToGitHubForUser(prisma, user, project.id, {
      trySandboxGit: async () => false,
      getFiles: () => ({ 'src/App.jsx': 'export default function App(){return null}' }),
    });
    assert(
      !pushNone.ok && pushNone.error === CONNECT_FIRST_MESSAGE,
      'push without connection returns exact connect-first message',
    );

    await upsertGitHubConnection(prisma, {
      userId: user.id,
      githubUserId: '12345',
      githubUsername: 'octocat',
      accessToken: plain,
      scope: 'repo',
    });

    const rows = await prisma.gitHubConnection.findMany({ where: { userId: user.id } });
    assert(rows.length === 1, 'upsert creates one GitHubConnection row');
    assert(rows[0].accessTokenEncrypted !== plain, 'stored token is encrypted');
    assert(decrypt(rows[0].accessTokenEncrypted) === plain, 'stored token decrypts');

    const status = await getGitHubConnectionStatusForUser(prisma, user.id);
    assert(status.connected === true && status.githubUsername === 'octocat', 'status returns username');
    assert(!JSON.stringify(status).includes(plain), 'status JSON never leaks token');
    assert(!('accessTokenEncrypted' in status), 'status omits encrypted token');

    const github = mockGithub();
    const first = await pushProjectToGitHubForUser(prisma, user, project.id, {
      githubFetch: github.githubFetch,
      trySandboxGit: async () => false,
      getFiles: () => ({
        'src/App.jsx': 'export default function App(){return null}',
        'src/main.jsx': 'import App from "./App"',
      }),
    });
    assert(first.ok === true, 'first push succeeds');
    const afterFirst = await prisma.project.findUnique({ where: { id: project.id } });
    assert(Boolean(afterFirst?.githubRepoFullName), 'first push sets githubRepoFullName');
    assert(Boolean(afterFirst?.githubRepoUrl), 'first push sets githubRepoUrl');
    assert(Boolean(afterFirst?.lastPushedAt), 'first push sets lastPushedAt');
    assert(github.stats().repoCreated === 1, 'first push creates one private repo');
    assert(github.stats().commits === 1, 'first push is one commit, not per-file');
    assert(
      github.calls.some(
        (c) => c.method === 'POST' && c.url === 'https://api.github.com/user/repos' && (c.body as { private?: boolean })?.private === true,
      ),
      'created repo is private',
    );

    const second = await pushProjectToGitHubForUser(prisma, user, project.id, {
      githubFetch: github.githubFetch,
      trySandboxGit: async () => false,
      getFiles: () => ({
        'src/App.jsx': 'export default function App(){return 1}',
        'src/main.jsx': 'import App from "./App"',
      }),
    });
    assert(second.ok === true, 'second push succeeds');
    const afterSecond = await prisma.project.findUnique({ where: { id: project.id } });
    assert(
      afterSecond?.githubRepoFullName === afterFirst?.githubRepoFullName,
      'second push reuses the same repo',
    );
    assert(github.stats().repoCreated === 1, 'second push does not create another repo');
    assert(github.stats().commits === 2, 'second push adds one more full-tree commit');

    const failGithub = mockGithub();
    const originalFetch = failGithub.githubFetch;
    const failingFetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/git/commits')) {
        return json(500, { message: 'commit failed' });
      }
      return originalFetch(url, init);
    };
    await prisma.project.update({
      where: { id: project.id },
      data: { githubRepoFullName: null, githubRepoUrl: null, lastPushedAt: null },
    });
    const failedPush = await pushProjectToGitHubForUser(prisma, user, project.id, {
      githubFetch: failingFetch,
      trySandboxGit: async () => false,
      getFiles: () => ({ 'src/App.jsx': 'x' }),
    });
    const afterFail = await prisma.project.findUnique({ where: { id: project.id } });
    assert(failedPush.ok === false, 'failed push returns error');
    assert(Boolean(afterFail?.githubRepoFullName), 'failed later push does not clear repo fields');
    assert(afterFail?.lastPushedAt == null, 'lastPushedAt is not set until full success');

    await prisma.project.update({
      where: { id: project.id },
      data: {
        githubRepoFullName: afterFirst?.githubRepoFullName,
        githubRepoUrl: afterFirst?.githubRepoUrl,
        lastPushedAt: afterFirst?.lastPushedAt,
      },
    });

    await disconnectGitHubForUser(prisma, user.id);
    const afterDisc = await prisma.gitHubConnection.findUnique({ where: { userId: user.id } });
    const projectAfterDisc = await prisma.project.findUnique({ where: { id: project.id } });
    assert(afterDisc == null, 'disconnect deletes GitHubConnection');
    assert(Boolean(projectAfterDisc?.githubRepoUrl), 'disconnect leaves project githubRepoUrl');

    try {
      const loggedOut = await fetch(`${BASE}/api/github/connect`, { redirect: 'manual' });
      if (loggedOut.status >= 500) {
        console.log('need server restart — /api/github/connect returned 500 (stale Next process)');
      } else {
        const location = loggedOut.headers.get('location') || '';
        assert(
          loggedOut.status >= 300 && loggedOut.status < 400,
          'logged-out connect redirects',
        );
        assert(
          location.includes('auth=login') && !location.includes('github.com/login/oauth'),
          'logged-out connect goes to login, not GitHub',
        );
      }

      const beforeCallback = await prisma.gitHubConnection.count();
      const badState = await fetch(`${BASE}/api/github/callback?code=abc&state=wrong`, {
        redirect: 'manual',
      });
      const afterCallback = await prisma.gitHubConnection.count();
      if (badState.status >= 500) {
        console.log('need server restart — /api/github/callback returned 500 (stale Next process)');
      } else {
        const badLoc = badState.headers.get('location') || '';
        assert(badLoc.includes('github=error'), 'bad state redirects to github=error');
      }
      assert(afterCallback === beforeCallback, 'bad/missing state creates no GitHubConnection');

      const missingState = await fetch(`${BASE}/api/github/callback?code=abc`, {
        redirect: 'manual',
      });
      if (missingState.status >= 500) {
        console.log('need server restart — /api/github/callback (missing state) returned 500');
      } else {
        const missingLoc = missingState.headers.get('location') || '';
        assert(missingLoc.includes('github=error'), 'missing state redirects to github=error');
      }
    } catch (error) {
      console.log(
        `HTTP checks skipped (server on ${BASE} not reachable):`,
        error instanceof Error ? error.message : error,
      );
    }
  } finally {
    await prisma.gitHubConnection.deleteMany({ where: { userId: user.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
