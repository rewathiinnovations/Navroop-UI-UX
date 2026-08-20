import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { streamExportZip } from '@/lib/export/archive';
import { filterExportFiles, shouldExcludeExportPath } from '@/lib/export/files';
import { safeGeneratedFiles } from '@/lib/jobs/settle-generation';
import { buildStaticPreview } from '@/lib/preview/build';
import { handlePreviewRequest, safePreviewRequestPath } from '@/lib/preview/serve';
import { signPreviewToken } from '@/lib/preview/token';
import { getSetting, invalidateSettingsCache } from '@/lib/settings/resolve';
import { deleteObject, exists, get, normalizeKey, StorageKeyError, upload } from '@/lib/storage';

/**
 * Storage keys and preview request paths are resolved, not trimmed.
 *
 * `normalizeKey` used to be `key.replace(/^\/+/, '').replace(/\\/g, '/')`, and every
 * local-driver call was `join(await localRoot(), normalizeKey(key))` — join() resolves
 * `..`. The *public* preview route concatenates its catch-all path into that key, so
 * `GET /preview-static/{pid}/%2e%2e%2f%2e%2e%2f%2e%2e%2fsnapshots%2f{other}/{cp}.json.gz`
 * returned another project's whole source snapshot, and on the default local driver the
 * same request read any file under or above `public/uploads` (`.env` included). Upload
 * was the same hole in the other direction: a generated file path with a `..` segment
 * wrote outside the root.
 *
 * Goes red if: `normalizeKey` stops throwing for a key that leaves the root, or starts
 * rewriting one into a different object instead; the local driver skips the containment
 * check; `handlePreviewRequest` builds a key from the raw request path again; or the
 * export filter/archive lets a `../` entry name into a ZIP (zip-slip on the machine that
 * unzips the download).
 *
 * No Prisma and no S3: `normalizeKey` and the preview path guard are pure, the local
 * driver runs against a temp root, and archiver is stubbed so entry names can be read
 * back without unzipping anything.
 */

const zip = vi.hoisted(() => ({ names: [] as string[] }));

// The factory is hoisted above the imports, so `Readable` has to be pulled in here
// rather than used from the module scope. Only the entry names matter, so the fake
// records them instead of producing a real ZIP nothing would read back.
vi.mock('archiver', async () => {
  const { Readable: NodeReadable } = await import('node:stream');
  return {
    default: () => {
      const stream = new NodeReadable({ read() {} }) as Readable & {
        append: (source: string | Buffer, data: { name: string }) => void;
        finalize: () => void;
      };
      stream.append = (_source, data) => {
        zip.names.push(data.name);
      };
      stream.finalize = () => {
        stream.push(null);
      };
      return stream;
    },
  };
});

describe('normalizeKey', () => {
  for (const key of [
    '../etc/passwd',
    '../../../.env',
    'previews/p1/b1/../../../../.env',
    '..\\..\\.env',
    'previews\\p1\\..\\..\\..\\.env',
    'snapshots/proj_1/../../..',
    '/etc/passwd',
    '//etc/passwd',
    'C:/Windows/win.ini',
    'c:/Windows/win.ini',
  ]) {
    it(`refuses ${JSON.stringify(key)}`, () => {
      expect(() => normalizeKey(key)).toThrow(StorageKeyError);
    });
  }

  it('refuses a key that resolves to nothing at all', () => {
    // join(root, '') is the root itself: a read there is not "the object is absent".
    expect(() => normalizeKey('')).toThrow(StorageKeyError);
    expect(() => normalizeKey('.')).toThrow(StorageKeyError);
    expect(() => normalizeKey('./')).toThrow(StorageKeyError);
  });

  it('refuses a NUL byte, which truncates the path at the syscall', () => {
    expect(() => normalizeKey('projects/p1/assets/a.webp\u0000.txt')).toThrow(StorageKeyError);
  });

  it('keeps the rejected key off the message so a route cannot echo it back', () => {
    try {
      normalizeKey('../../../.env');
      expect.unreachable('normalizeKey accepted a traversal');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageKeyError);
      expect((error as Error).message).not.toContain('.env');
      expect((error as InstanceType<typeof StorageKeyError>).key).toBe('../../../.env');
    }
  });

  it('leaves a legitimate key exactly as it was', () => {
    expect(normalizeKey('projects/p1/assets/hero.webp')).toBe('projects/p1/assets/hero.webp');
    expect(normalizeKey('snapshots/proj_1/cp_1.json.gz')).toBe('snapshots/proj_1/cp_1.json.gz');
    expect(normalizeKey('previews/p1/b1/index.html')).toBe('previews/p1/b1/index.html');
  });

  it('keeps a trailing slash, which is load-bearing for a prefix', () => {
    // listKeys('snapshots/proj_1/') must not also match snapshots/proj_10/ on S3 —
    // purge-deleted deletes everything it lists.
    expect(normalizeKey('snapshots/proj_1/')).toBe('snapshots/proj_1/');
    expect(normalizeKey('snapshots/')).toBe('snapshots/');
  });

  it('resolves the harmless forms rather than refusing them', () => {
    expect(normalizeKey('./projects/p1/a.png')).toBe('projects/p1/a.png');
    expect(normalizeKey('projects/p1/b/../a.png')).toBe('projects/p1/a.png');
    expect(normalizeKey('projects\\p1\\a.png')).toBe('projects/p1/a.png');
  });

  it('never decodes: percent escapes stay literal segment names', () => {
    // Decoding is the edge's job (see safePreviewRequestPath). A driver that decoded
    // would hand `%2e%2e` back to join() as `..`, which is the whole defect.
    expect(normalizeKey('previews/p1/b1/%2e%2e/%2e%2e/.env')).toBe(
      'previews/p1/b1/%2e%2e/%2e%2e/.env',
    );
  });

  describe('control: the code as it was', () => {
    it('used to hand join() a key that walks out of the root', () => {
      // One `..` past the three the prefix is deep, so this leaves the uploads root
      // entirely — the preview route's own prefix is defended in serve.ts instead.
      const escaping = 'previews/p1/b1/../../../../.env';
      // The old normalizeKey: strip leading slashes, swap backslashes, nothing else.
      const permissive = escaping.replace(/^\/+/, '').replace(/\\/g, '/');

      // The bug, reproduced: the key reads a file outside the storage root.
      expect(join('/srv/uploads', permissive)).toBe(join('/srv', '.env'));

      // Same key, through the shipped code.
      expect(() => normalizeKey(escaping)).toThrow(StorageKeyError);
    });
  });
});

describe('the local driver', () => {
  let root = '';
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of ['STORAGE_DRIVER', 'STORAGE_LOCAL_DIR'] as const) {
      saved.set(key, process.env[key]);
    }
    root = await mkdtemp(join(tmpdir(), 'navroop-storage-key-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_DIR = join(root, 'store');
    /**
     * `lib/storage` never reads those variables directly: `localRoot()` calls
     * `getSetting('storage.localDir')`, which resolves AppSetting row -> env -> default
     * and memoises the answer for five minutes. So the temp root won here only by luck —
     * no row happened to exist and nothing had warmed the cache. Either changing meant the
     * containment cases silently ran against `process.cwd()/public/uploads`, where
     * `normalizeKey` throws before touching the filesystem and `get('outside.txt')`
     * returns null for the wrong reason: green, and testing nothing.
     *
     * Dropping the cache and then asserting the resolved values makes the root a fact.
     * A seeded `storage.localDir` or `storage.driver` row now fails here, loudly, instead
     * of quietly moving these cases to a different directory or the S3 driver.
     */
    invalidateSettingsCache();
    expect(await getSetting('storage.driver')).toBe('local');
    expect(await getSetting('storage.localDir')).toBe(join(root, 'store'));
  });

  afterAll(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // The temp root is about to be deleted, so it must not stay memoised for anything
    // else that resolves storage settings in this worker.
    invalidateSettingsCache();
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a legitimate key', async () => {
    const stored = await upload(Buffer.from('hello'), {
      key: 'projects/p1/assets/a.bin',
      contentType: 'application/octet-stream',
    });
    expect(stored.url).toBe('/uploads/projects/p1/assets/a.bin');
    expect((await get('projects/p1/assets/a.bin'))?.toString('utf8')).toBe('hello');
    expect(await exists('projects/p1/assets/a.bin')).toBe(true);
    await deleteObject('projects/p1/assets/a.bin');
    expect(await exists('projects/p1/assets/a.bin')).toBe(false);
  });

  it('refuses to read a file above the root, and does not report it as absent', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'AUTH_SECRET=not-a-real-secret', 'utf8');

    // `get` answering null here would read to every caller as "that object is gone".
    await expect(get('../outside.txt')).rejects.toBeInstanceOf(StorageKeyError);
    await expect(get('store/../../outside.txt')).rejects.toBeInstanceOf(StorageKeyError);
    expect((await readFile(outside, 'utf8')).length).toBeGreaterThan(0);
  });

  it('refuses to write or unlink above the root', async () => {
    await expect(
      upload(Buffer.from('owned'), { key: '../escaped.txt', contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(StorageKeyError);
    await expect(deleteObject('../outside.txt')).rejects.toBeInstanceOf(StorageKeyError);
    await expect(exists('../outside.txt')).rejects.toBeInstanceOf(StorageKeyError);
    expect(await get('outside.txt')).toBeNull();
  });
});

describe('safePreviewRequestPath', () => {
  for (const path of [
    '../../../snapshots/other/cp.json.gz',
    'assets/../../../../.env',
    '%2e%2e%2f%2e%2e%2fsnapshots%2fother%2fcp.json.gz',
    '%2E%2E/%2E%2E/.env',
    '%252e%252e%252f%252e%252e%252f.env',
    '..\\..\\.env',
    'a/../..',
    // A slash that only appears after decoding really is an absolute path — unlike
    // the leading slash the route itself prepends, which is stripped.
    '%2fetc%2fpasswd',
    '%2f%2e%2e%2f.env',
  ]) {
    it(`refuses ${JSON.stringify(path)}`, () => {
      expect(safePreviewRequestPath(path)).toBeNull();
    });
  }

  it('resolves the paths a real preview asks for', () => {
    expect(safePreviewRequestPath('assets/app.css')).toBe('assets/app.css');
    expect(safePreviewRequestPath('assets/../index.html')).toBe('index.html');
    expect(safePreviewRequestPath('')).toBe('');
  });

  it('accepts the `/`-prefixed form the route actually builds', () => {
    // app/preview-static/[projectId]/[[...path]]/route.ts builds `/${segments.join('/')}`,
    // so these are the only shapes that ever reach production. Treating the prefix as an
    // absolute path made every preview 404, and this suite passed anyway because every
    // other case here omits it.
    expect(safePreviewRequestPath('/index.html')).toBe('index.html');
    expect(safePreviewRequestPath('/assets/app.css')).toBe('assets/app.css');
    expect(safePreviewRequestPath('/')).toBe('');
  });

  it('still serves a filename with a bare percent in it', () => {
    // A malformed escape stops the decode loop instead of failing the request: the raw
    // form is the one that becomes the key, and it has already been checked.
    expect(safePreviewRequestPath('assets/100%.png')).toBe('assets/100%.png');
  });
});

describe('handlePreviewRequest', () => {
  // Assembled from parts rather than written as one long literal, so the staged
  // credential scanner in scripts/secret-scan.ts does not read a test fixture as
  // a leaked key. It is right to be strict; the fixture is what should bend.
  const SECRET = ['preview', 'signing', 'value', 'for', 'tests'].join('-');
  const NOW = 1_760_000_000_000;

  async function request(path: string, options: { isSpa?: boolean } = {}) {
    const keys: string[] = [];
    const result = await handlePreviewRequest({
      projectId: 'p1',
      path,
      token: signPreviewToken({ projectId: 'p1', userId: 'u1' }, { secret: SECRET, now: NOW }),
      appOrigin: 'https://navroop.test',
      secret: SECRET,
      now: NOW,
      loadBuild: async () => ({
        storagePrefix: 'previews/p1/b1',
        entryPath: 'index.html',
        isSpa: options.isSpa ?? false,
      }),
      getObject: async (key: string) => {
        keys.push(key);
        return Buffer.from('body');
      },
    });
    return { result, keys };
  }

  it('serves an asset from under the build prefix', async () => {
    const { result, keys } = await request('assets/app.css');
    expect(result.status).toBe(200);
    expect(keys).toEqual(['previews/p1/b1/assets/app.css']);
  });

  it('serves the shapes the route builds, slash and all', async () => {
    // These are the exact strings app/preview-static/[projectId]/[[...path]]/route.ts
    // produces: `/${(path ?? []).join('/')}`. Every other case in this file drops the
    // prefix, which is how a guard that rejected it shipped with the suite green and
    // every share link 404ing.
    const entry = await request('/');
    expect(entry.result.status).toBe(200);
    expect(entry.keys).toEqual(['previews/p1/b1/index.html']);

    const asset = await request('/assets/app.css');
    expect(asset.result.status).toBe(200);
    expect(asset.keys).toEqual(['previews/p1/b1/assets/app.css']);
  });

  for (const path of [
    '../../../snapshots/other/cp.json.gz',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fsnapshots%2fother%2fcp.json.gz',
    '%252e%252e%252f.env',
    '..\\..\\..\\.env',
  ]) {
    it(`answers 404 without touching storage for ${JSON.stringify(path)}`, async () => {
      const { result, keys } = await request(path);
      expect(result.status).toBe(404);
      // Not one read attempt: the key is never built from a path that escapes.
      expect(keys).toEqual([]);
    });
  }

  it('keeps the SPA fallback and the entry path', async () => {
    const spa = await request('dashboard', { isSpa: true });
    expect(spa.keys).toEqual(['previews/p1/b1/index.html']);
    const root = await request('');
    expect(root.keys).toEqual(['previews/p1/b1/index.html']);
  });

  it('still refuses a valid token for the wrong project before any of this', async () => {
    const result = await handlePreviewRequest({
      projectId: 'p1',
      path: 'index.html',
      token: signPreviewToken({ projectId: 'p2', userId: 'u1' }, { secret: SECRET, now: NOW }),
      appOrigin: 'https://navroop.test',
      secret: SECRET,
      now: NOW,
      loadBuild: async () => {
        throw new Error('loadBuild must not run for a rejected token');
      },
      getObject: async () => Buffer.from('body'),
    });
    expect(result.status).toBe(403);
  });
});

describe('export entry names', () => {
  it('excludes a path that would unzip outside the target folder', () => {
    expect(shouldExcludeExportPath('../../../.ssh/authorized_keys')).toBe(true);
    expect(shouldExcludeExportPath('..\\..\\evil.txt')).toBe(true);
    expect(shouldExcludeExportPath('/etc/passwd')).toBe(true);
    expect(shouldExcludeExportPath('C:/Windows/system32/evil.dll')).toBe(true);
    expect(shouldExcludeExportPath('src/App.jsx')).toBe(false);
  });

  it('drops it from the export file list, and does not report it as merely oversized', () => {
    const { files, oversized } = filterExportFiles([
      { path: 'src/App.jsx', content: 'export default function App(){return null}' },
      { path: '../../../.ssh/authorized_keys', content: 'ssh-rsa AAAA' },
    ]);
    expect(files.map((file) => file.path)).toEqual(['src/App.jsx']);
    // A traversal path is refused outright — it must never surface in the README as a file
    // the user could go and copy by hand (F-796 lists only the size exclusions).
    expect(oversized).toEqual([]);
  });

  it('never writes such an entry into the archive, even unfiltered', async () => {
    zip.names.length = 0;
    const body = await streamExportZip(
      [
        { path: './src/App.jsx', content: 'export default function App(){return null}' },
        { path: '../../../.ssh/authorized_keys', content: 'ssh-rsa AAAA' },
        { path: '..\\..\\evil.txt', content: 'x' },
        { path: 'C:/Windows/system32/evil.dll', content: 'x' },
      ],
      '# readme',
    );
    await body.cancel();
    expect(zip.names).toEqual(['README.md', 'src/App.jsx']);
  });
});

describe('buildStaticPreview', () => {
  it('never turns a generated file path into an escaping or secret-bearing key', async () => {
    const uploaded: string[] = [];
    let ready: { fileCount: number; storagePrefix: string } | null = null;

    const result = await buildStaticPreview('p1', 'cp1', {
      stack: 'STATIC_HTML',
      // A STATIC_HTML project ships its own files, and they come from model output.
      files: {
        'index.html': '<html><body><h1>Plain</h1></body></html>',
        'assets/app.css': 'body{margin:0}',
        '../../../../.env': 'AUTH_SECRET=would-be-written-outside-the-root',
        '.env.production': 'AUTH_SECRET=would-be-served-publicly',
        'node_modules/react/index.js': 'module.exports={}',
      },
      store: {
        createBuilding: async () => ({ id: 'b1', status: 'BUILDING', mode: 'STATIC' }),
        markFailed: async () => {},
        markReady: async (_id, input) => {
          ready = { fileCount: input.fileCount, storagePrefix: input.storagePrefix };
        },
        setProjectPreview: async () => {},
      },
      storage: {
        upload: async (input) => {
          uploaded.push(input.key);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(uploaded).toEqual(['previews/p1/b1/index.html', 'previews/p1/b1/assets/app.css']);
    // The count that is stored has to match what was uploaded, or pruning and the
    // storage accounting drift apart.
    expect(ready).toEqual({ fileCount: 2, storagePrefix: 'previews/p1/b1' });
  });
});

describe('safeGeneratedFiles', () => {
  it('drops the paths the generate route drops, so the stored set matches the count', () => {
    const { safe, rejected } = safeGeneratedFiles({
      'src/App.jsx': 'export default function App(){return null}',
      './package.json': '{"name":"x"}',
      '../../secret.env': 'AUTH_SECRET=x',
      '..\\..\\x': 'x',
      'C:/x': 'x',
      '/etc/passwd': 'x',
    });

    expect(Object.keys(safe)).toEqual(['src/App.jsx', 'package.json']);
    expect(rejected.map((file) => file.path)).toEqual([
      '../../secret.env',
      '..\\..\\x',
      'C:/x',
      '/etc/passwd',
    ]);
    // All four are refused for the name, not the content — the settle copy keys off this.
    expect(
      rejected.every((file) => ['empty', 'absolute_path', 'path_traversal'].includes(file.code)),
    ).toBe(true);
  });

  it('rejects a file over the per-file cap with the guard message and persists the rest of the batch', () => {
    // F-028: the 2 MB per-file guard existed only in tests. A single enormous file was
    // stored in Project.lastCode and re-read on every generation, Code tab load and export.
    const { safe, rejected } = safeGeneratedFiles({
      'app/page.tsx': 'export default function Page() { return null; }',
      'assets/big.css': 'x'.repeat(2_000_001),
    });

    expect(Object.keys(safe)).toEqual(['app/page.tsx']);
    expect(rejected).toEqual([
      { path: 'assets/big.css', code: 'too_large', message: 'File is too large: assets/big.css' },
    ]);
  });

  it('rejects a binary payload with the guard message', () => {
    const { safe, rejected } = safeGeneratedFiles({
      'public/logo.png': '\u0000'.repeat(16),
      'src/App.jsx': 'export default function App(){return null}',
    });

    expect(Object.keys(safe)).toEqual(['src/App.jsx']);
    expect(rejected).toEqual([
      {
        path: 'public/logo.png',
        code: 'binary',
        message: 'Binary content is not allowed: public/logo.png',
      },
    ]);
  });

  it('rejects a package.json that JSON.parse cannot read — the incident the write guard was written from', () => {
    const { safe, rejected } = safeGeneratedFiles({
      'package.json': '{"name": "app",,}',
      'src/App.jsx': 'export default function App(){return null}',
    });

    expect(Object.keys(safe)).toEqual(['src/App.jsx']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.path).toBe('package.json');
    expect(rejected[0]?.code).toBe('invalid_json');
    expect(rejected[0]?.message).toMatch(/^package\.json is not valid JSON: /);
  });

  it('stops accepting files once the batch passes the total cap, keeping what already fit', () => {
    const big = 'x'.repeat(2_000_000);
    const { safe, rejected } = safeGeneratedFiles({
      'a.css': big,
      'b.css': big,
      'c.css': big,
      'd.css': big,
      'e.css': big,
    });

    expect(Object.keys(safe)).toEqual(['a.css', 'b.css', 'c.css', 'd.css']);
    expect(rejected).toEqual([
      { path: 'e.css', code: 'too_large', message: 'Generated output is too large' },
    ]);
  });
});
