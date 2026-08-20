import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-261: `pushFiles` inlined every file into one `POST /git/trees` with no bound on the
 * count, on any single file, or on the whole body — and no answer at all for a file that is
 * not text. A large generated site failed the publish with whatever GitHub says about its
 * own limits, after the bytes had been sent, recorded as `provider_error`; a binary file
 * handed to the inline `content` field was stored mangled, which is worse than a refusal.
 *
 * Both halves are asserted, because either alone is a trap: the refusals must happen
 * *before* any request (a guard that fires after the tree POST has already paid for it),
 * and an ordinary site — including one carrying real image bytes — must still push.
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

// Dynamic, not static: `deploy-client` reads the integration store and the data dir at
// evaluation time, so it has to load after the `vi.mock` factories above are in place.
const { pushFiles, PushRefusedError, pushEntryByteLength, MAX_PUSH_ENTRIES } =
  await import('@/lib/github/deploy-client');
const { assertPushableFiles, MAX_PUSH_FILE_BYTES, MAX_PUSH_INLINE_BYTES, MAX_PUSH_TOTAL_BYTES } =
  await import('@/lib/github/push-limits');
const { publishJobErrorCode } = await import('@/lib/publish/files');

const CONNECTED = {
  status: 'CONNECTED',
  secrets: { appId: '1', privateKey: 'pk', installationId: 'inst-1' },
  config: { org: 'deploy-org' },
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };

const fetchMock = vi.fn();

/** GitHub answering every step of a successful push; returns the calls it saw. */
function githubHappyPath() {
  const calls: Call[] = [];
  let blob = 0;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (method === 'GET' && url.includes('/git/ref/heads/')) {
      return json(200, { object: { sha: 'head1' } });
    }
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      blob += 1;
      return json(201, { sha: `blob${blob}` });
    }
    if (method === 'POST' && url.endsWith('/git/trees')) return json(201, { sha: 'tree1' });
    if (method === 'POST' && url.endsWith('/git/commits')) return json(201, { sha: 'commit1' });
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) return json(200, {});
    return json(404, { message: `unhandled ${method} ${url}` });
  });
  return calls;
}

function push(files: Record<string, string | { base64: string }>) {
  return pushFiles('deploy-org/acme', files, 'Publish live acme', 'default');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  dataDir.readCacheJson.mockImplementation(() => ({
    default: { token: 'installation-token', expiresAt: Date.now() + 3_600_000 },
  }));
  dataDir.writeCacheJson.mockReturnValue({ ok: true });
  store.getIntegration.mockResolvedValue(CONNECTED);
  db.prisma.workspace.findUnique.mockResolvedValue({ githubOrgInstallationId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pushFiles size guards', () => {
  it('refuses more inline text than one tree request holds, before any request', async () => {
    const calls = githubHappyPath();
    // Four files of 2 MB each: past the 7 MB the tree body takes, under the per-file cap,
    // so it is the total that has to refuse this.
    const files = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((name) => [`${name}.html`, 'x'.repeat(2 * 1024 * 1024)]),
    );

    const error = await push(files).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as Error).message).toMatch(/8\.0 MB/);
    expect((error as Error).message).toMatch(/7\.0 MB/);
    // Largest contributors, named so the reader knows what to delete.
    expect((error as Error).message).toMatch(/a\.html \(2\.0 MB\)/);
    // The whole point of the ordering: GitHub was never called.
    expect(calls).toEqual([]);
    // And the panel gets a code of its own rather than "the AI service did not respond".
    expect(publishJobErrorCode(error)).toBe('push_refused');
    expect(publishJobErrorCode(new Error('boom'))).toBe('provider_error');
  });

  it('refuses one oversized file by name, before any request', async () => {
    const calls = githubHappyPath();
    const error = await push({
      'index.html': '<h1>Hi</h1>',
      'video.bin': { base64: Buffer.alloc(MAX_PUSH_FILE_BYTES + 1).toString('base64') },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as Error).message).toContain('video.bin');
    expect((error as Error).message).toMatch(/25\.0 MB/);
    expect(calls).toEqual([]);
  });

  it('refuses a text file whose bytes cannot survive the wire, rather than mangling it', async () => {
    const calls = githubHappyPath();
    // A lone high surrogate: Node's fetch would encode it as U+FFFD, so GitHub would store
    // a file that differs from the generated one and nothing would say so.
    const error = await push({ 'index.html': `<h1>Hi \ud800</h1>` }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as Error).message).toContain('index.html');
    expect(calls).toEqual([]);
  });

  it('still pushes an ordinary text site', async () => {
    const calls = githubHappyPath();

    await expect(push({ 'index.html': '<h1>Hi</h1>', 'app.css': 'body{}' })).resolves.toBe(
      'commit1',
    );

    const tree = calls.find((call) => call.url.endsWith('/git/trees'));
    expect(tree?.body?.tree).toEqual([
      { path: 'index.html', mode: '100644', type: 'blob', content: '<h1>Hi</h1>' },
      { path: 'app.css', mode: '100644', type: 'blob', content: 'body{}' },
    ]);
    // No blob round-trip for text: the inline field is why one commit is one request.
    expect(calls.some((call) => call.url.endsWith('/git/blobs'))).toBe(false);
  });

  it('uploads a binary file as a base64 blob and references it by sha', async () => {
    const calls = githubHappyPath();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

    await expect(
      push({
        'index.html': '<img src="/hero.png">',
        'hero.png': { base64: png.toString('base64') },
      }),
    ).resolves.toBe('commit1');

    const blob = calls.find((call) => call.url.endsWith('/git/blobs'));
    expect(blob?.body).toEqual({ content: png.toString('base64'), encoding: 'base64' });
    const tree = calls.find((call) => call.url.endsWith('/git/trees'));
    expect(tree?.body?.tree).toEqual([
      { path: 'index.html', mode: '100644', type: 'blob', content: '<img src="/hero.png">' },
      { path: 'hero.png', mode: '100644', type: 'blob', sha: 'blob1' },
    ]);
    // The blob is created before the tree that names its sha.
    const order = calls.map((call) => call.url.split('/git/')[1]);
    expect(order.indexOf('blobs')).toBeLessThan(order.indexOf('trees'));
  });

  it('a site of real images passes: blobs do not count against the inline text ceiling', async () => {
    githubHappyPath();
    // 5 MB of webp — the shape PublishAssets ships — plus a small page.
    const files = {
      'index.html': '<img src="/a.webp"><img src="/b.webp">',
      'a.webp': { base64: Buffer.alloc(3 * 1024 * 1024, 7).toString('base64') },
      'b.webp': { base64: Buffer.alloc(2 * 1024 * 1024, 9).toString('base64') },
    };

    expect(Object.values(files).reduce((sum, entry) => sum + pushEntryByteLength(entry), 0)).toBe(
      5 * 1024 * 1024 + files['index.html'].length,
    );
    await expect(push(files)).resolves.toBe('commit1');
  });
});

describe('assertPushableFiles', () => {
  it('measures decoded bytes, so base64 is not counted at 4/3 of its payload', () => {
    const payload = Buffer.alloc(1024, 3);
    expect(pushEntryByteLength({ base64: payload.toString('base64') })).toBe(1024);
    expect(pushEntryByteLength('a'.repeat(1024))).toBe(1024);
    // utf-8, not code units: a 3-byte character counts as three.
    expect(pushEntryByteLength('€')).toBe(3);
  });

  it('refuses a set past the documented tree entry cap without measuring every file', () => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i <= MAX_PUSH_ENTRIES; i += 1) entries.push([`f${i}.txt`, 'x']);

    const error = (() => {
      try {
        assertPushableFiles(entries);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as Error).message).toContain(String(MAX_PUSH_ENTRIES));
  });

  it('refuses a total past the per-publish ceiling even when every file is small enough', () => {
    const entries: Array<[string, { base64: string }]> = [];
    const chunk = { base64: Buffer.alloc(10 * 1024 * 1024, 1).toString('base64') };
    for (let i = 0; i < 6; i += 1) entries.push([`asset-${i}.webp`, chunk]);

    const error = (() => {
      try {
        assertPushableFiles(entries);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as Error).message).toMatch(/60\.0 MB/);
    expect((error as Error).message).toMatch(/50\.0 MB/);
  });

  // Control: the guard is not simply throwing on everything, and it reports what it read.
  it('control: a set at the ceilings is allowed and its totals are returned', () => {
    const text = 'x'.repeat(MAX_PUSH_INLINE_BYTES);
    const binary = { base64: Buffer.alloc(1024, 5).toString('base64') };

    expect(
      assertPushableFiles([
        ['index.html', text],
        ['a.webp', binary],
      ]),
    ).toEqual({
      inlineBytes: MAX_PUSH_INLINE_BYTES,
      totalBytes: MAX_PUSH_INLINE_BYTES + 1024,
    });
    expect(MAX_PUSH_TOTAL_BYTES).toBeGreaterThan(MAX_PUSH_INLINE_BYTES);
  });
});
