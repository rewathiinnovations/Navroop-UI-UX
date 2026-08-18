import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMorphEditToFile, normalizeProjectPath } from '@/lib/morph-fast-apply';

/**
 * Morph apply used to treat three different failures as success:
 * a relative `cat` that threw (then never checked the next reader honestly),
 * an absolute `cat` that threw, and a `mkdir -p` that failed for a real reason
 * (permissions / disk). A failed `cat` that returned `{ stdout: '', exitCode: 1 }`
 * was also treated as "the file is empty", so Morph merged against nothing and
 * the apply route reported an update.
 *
 * Fetch is stubbed — nothing here can reach Morph. The sandbox is a plain object.
 */

const ORIGINAL = 'export default function App(){return <h1>Was</h1>}';
const MERGED = 'export default function App(){return <h1>Now</h1>}';
const REAL_ON_DISK = 'export default function App(){return <h1>On disk</h1>}';

let previousMorphKey: string | undefined;
let morphBodies: string[];

function stubMorphMerge(merged = MERGED) {
  vi.stubGlobal(
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      morphBodies.push(String(init?.body ?? ''));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: merged } }] }),
        text: async () => '',
      };
    },
  );
}

beforeEach(() => {
  previousMorphKey = process.env.MORPH_API_KEY;
  process.env.MORPH_API_KEY = 'test-morph-key-not-real';
  morphBodies = [];
  stubMorphMerge();
});

afterEach(() => {
  if (previousMorphKey === undefined) delete process.env.MORPH_API_KEY;
  else process.env.MORPH_API_KEY = previousMorphKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function apply(sandbox: object, targetPath = 'src/components/Widget.tsx') {
  return applyMorphEditToFile({
    sandbox,
    targetPath,
    instructions: 'update the heading',
    updateSnippet: 'return <h1>Now</h1>',
    stack: 'REACT',
  });
}

describe('applyMorphEditToFile — read fallbacks', () => {
  it('does not treat a failed relative cat (empty stdout, exit 1) as an empty file', async () => {
    const sandbox = {
      runCommand: async (command: string) => {
        if (command === 'cat src/App.jsx') {
          return { stdout: '', stderr: 'No such file', exitCode: 1, success: false };
        }
        if (command === 'cat /home/user/app/src/App.jsx') {
          return { stdout: REAL_ON_DISK, stderr: '', exitCode: 0, success: true };
        }
        if (command.startsWith('mkdir')) {
          return { stdout: '', stderr: '', exitCode: 0, success: true };
        }
        return { stdout: '', stderr: '', exitCode: 0, success: true };
      },
    };

    const result = await apply(sandbox, 'src/App.jsx');

    expect(result.success).toBe(true);
    expect(morphBodies.join('\n')).toContain(REAL_ON_DISK);
    expect(morphBodies.join('\n')).not.toMatch(/<code><\/code>/);
  });

  it('tries the absolute sandbox path when the relative cat throws', async () => {
    const sandbox = {
      runCommand: async (command: string) => {
        if (command === 'cat src/App.jsx') {
          throw new Error('cat: src/App.jsx: No such file or directory');
        }
        if (command === 'cat /home/user/app/src/App.jsx') {
          return { stdout: REAL_ON_DISK, stderr: '', exitCode: 0, success: true };
        }
        if (command.startsWith('mkdir')) {
          return { stdout: '', stderr: '', exitCode: 0, success: true };
        }
        return { stdout: '', stderr: '', exitCode: 0, success: true };
      },
    };

    const result = await apply(sandbox, 'src/App.jsx');

    expect(result.success).toBe(true);
    expect(morphBodies.join('\n')).toContain(REAL_ON_DISK);
  });

  it('fails the apply when every reader misses the file, instead of merging against silence', async () => {
    const sandbox = {
      runCommand: async () => ({ stdout: '', stderr: 'No such file', exitCode: 1, success: false }),
    };

    const result = await apply(sandbox, 'src/App.jsx');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unable to read file: src\/App\.jsx/);
  });
});

describe('applyMorphEditToFile — mkdir and write must not look like success', () => {
  it('fails the apply when mkdir -p throws — the write cannot create the parent', async () => {
    const sandbox = {
      files: { read: async () => ORIGINAL },
      runCommand: async (command: string) => {
        if (command.startsWith('mkdir')) {
          throw new Error('Permission denied');
        }
        return { stdout: '', stderr: '', exitCode: 0, success: true };
      },
    };

    const result = await apply(sandbox);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Permission denied/);
  });

  it('fails the apply when mkdir -p returns a non-zero exit without throwing', async () => {
    const sandbox = {
      files: { read: async () => ORIGINAL },
      runCommand: async (command: string) => {
        if (command.startsWith('mkdir')) {
          return { stdout: '', stderr: 'No space left on device', exitCode: 1, success: false };
        }
        return { stdout: '', stderr: '', exitCode: 0, success: true };
      },
    };

    const result = await apply(sandbox);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to create directory src\/components/);
  });

  it('fails the apply when the heredoc write returns a non-zero exit', async () => {
    const sandbox = {
      files: { read: async () => ORIGINAL },
      runCommand: async (command: string) => {
        if (command.startsWith('mkdir')) {
          return { stdout: '', stderr: '', exitCode: 0, success: true };
        }
        return { stdout: '', stderr: 'Read-only file system', exitCode: 1, success: false };
      },
    };

    const result = await apply(sandbox);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to write file via shell: src\/components\/Widget\.tsx/);
  });
});

/**
 * normalizeProjectPath forced a `src/` prefix on every stack, using a hardcoded
 * React config-file list instead of the stack registry. On NEXTJS — the default
 * stack — that rewrote `app/page.tsx` to `src/app/page.tsx`, so the read missed
 * and the Morph edit landed in a stray file. Only REACT keeps sources in `src/`.
 */
describe('normalizeProjectPath — stack-aware prefixing', () => {
  it('leaves Next.js App Router paths alone', () => {
    expect(normalizeProjectPath('app/page.tsx', 'NEXTJS').normalizedPath).toBe('app/page.tsx');
    expect(normalizeProjectPath('app/layout.tsx', 'NEXTJS').normalizedPath).toBe('app/layout.tsx');
    expect(normalizeProjectPath('components/Hero.tsx', 'NEXTJS').normalizedPath).toBe(
      'components/Hero.tsx',
    );
  });

  it('still prefixes src/ for REACT', () => {
    expect(normalizeProjectPath('components/Hero.jsx', 'REACT').normalizedPath).toBe(
      'src/components/Hero.jsx',
    );
    expect(normalizeProjectPath('src/App.jsx', 'REACT').normalizedPath).toBe('src/App.jsx');
  });

  it('never prefixes the non-React stacks', () => {
    expect(normalizeProjectPath('src/pages/index.astro', 'ASTRO').normalizedPath).toBe(
      'src/pages/index.astro',
    );
    expect(normalizeProjectPath('index.html', 'STATIC_HTML').normalizedPath).toBe('index.html');
    expect(normalizeProjectPath('about.html', 'STATIC_HTML').normalizedPath).toBe('about.html');
    expect(normalizeProjectPath('src/routes/+page.svelte', 'SVELTE').normalizedPath).toBe(
      'src/routes/+page.svelte',
    );
  });

  it('leaves REACT config files and public/ at the root, and strips a leading slash', () => {
    expect(normalizeProjectPath('tailwind.config.js', 'REACT').normalizedPath).toBe(
      'tailwind.config.js',
    );
    expect(normalizeProjectPath('public/logo.svg', 'REACT').normalizedPath).toBe('public/logo.svg');
    expect(normalizeProjectPath('/app/page.tsx', 'NEXTJS').normalizedPath).toBe('app/page.tsx');
  });

  it('builds the sandbox absolute path from the normalized path', () => {
    expect(normalizeProjectPath('app/page.tsx', 'NEXTJS').fullPath).toBe(
      '/home/user/app/app/page.tsx',
    );
  });
});
