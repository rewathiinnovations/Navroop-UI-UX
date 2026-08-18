/**
 * The generation and apply routes used to reach these functions over HTTP and
 * dropped every failure into an `if (response.ok)` else branch. They are direct
 * calls now, so each one has to report failure as a typed result the caller can
 * act on. These tests pin the failure shapes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeEditIntent } from '../../lib/generation/analyze-edit-intent';
import { detectAndInstallPackages } from '../../lib/sandbox/detect-packages';
import { installPackages, precheckInstall } from '../../lib/sandbox/install-packages';
import { readSandboxFiles } from '../../lib/sandbox/read-files';
import { restartDevServer } from '../../lib/sandbox/restart-dev';
import { getSelfIdentity, resetSelfIdentityCache, SELF_UUID_NOT_CONFIGURED } from '../../lib/runtime/self';

type Mutable = Record<string, unknown>;

const globals = globalThis as unknown as Mutable;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  delete globals.activeSandbox;
  delete globals.activeSandboxProvider;
  delete globals.sandboxData;
  delete globals.lastViteRestartTime;
  delete globals.viteRestartInProgress;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSelfIdentityCache();
});

describe('analyzeEditIntent', () => {
  it('reports a missing prompt or manifest instead of calling the model', async () => {
    expect(await analyzeEditIntent({ prompt: '', manifest: { files: {} } })).toEqual({
      ok: false,
      status: 400,
      error: 'prompt and manifest are required',
    });
    expect(await analyzeEditIntent({ prompt: 'make it blue', manifest: null })).toEqual({
      ok: false,
      status: 400,
      error: 'prompt and manifest are required',
    });
  });

  it('reports an empty manifest rather than planning against nothing', async () => {
    const result = await analyzeEditIntent({
      prompt: 'make the header blue',
      // Numeric-suffixed paths are parser artefacts, not files.
      manifest: { files: { 'src/App/1': {} } },
    });
    expect(result).toEqual({ ok: false, status: 400, error: 'No valid files found in manifest' });
  });
});

describe('precheckInstall', () => {
  it('rejects an empty or non-array package list', () => {
    expect(precheckInstall(undefined)).toMatchObject({ kind: 'error', status: 400 });
    expect(precheckInstall([])).toMatchObject({ kind: 'error', status: 400 });
    expect(precheckInstall('react')).toMatchObject({ kind: 'error', status: 400 });
  });

  it('rejects a list that has no usable names left after cleaning', () => {
    expect(precheckInstall(['', '   ', null])).toMatchObject({
      kind: 'error',
      status: 400,
      error: 'No valid package names provided',
    });
  });

  it('reports a missing sandbox provider', () => {
    expect(precheckInstall(['react'])).toMatchObject({
      kind: 'error',
      status: 400,
      error: 'No active sandbox provider available',
    });
  });

  it('skips stacks that have no node dependencies', () => {
    globals.activeSandboxProvider = {};
    globals.sandboxData = { stack: 'STATIC_HTML' };
    expect(precheckInstall(['react'])).toMatchObject({ kind: 'skipped' });
  });

  it('deduplicates then trims, so padded duplicates survive as the route always allowed', () => {
    globals.activeSandboxProvider = {};
    globals.sandboxData = { stack: 'REACT' };
    expect(precheckInstall(['react', 'react', ' react ', 'zod'])).toEqual({
      kind: 'ready',
      packages: ['react', 'react', 'zod'],
    });
  });
});

describe('installPackages', () => {
  it('returns a failure result rather than throwing when there is no provider', async () => {
    const result = await installPackages({ packages: ['react'] });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'No active sandbox provider available',
    });
  });

  it('reports a non-zero npm exit code and still restarts the dev server', async () => {
    const restartViteServer = vi.fn().mockResolvedValue(undefined);
    globals.sandboxData = { stack: 'REACT' };
    globals.activeSandboxProvider = {
      runCommand: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('{"dependencies":{}}'),
      installPackages: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' }),
      restartViteServer,
    };

    const events: string[] = [];
    const result = await installPackages({
      packages: ['left-pad'],
      onProgress: (event) => {
        events.push(event.type);
      },
    });

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result.ok === false && result.error).toContain('left-pad');
    // pkill already took the server down, so it must come back either way.
    expect(restartViteServer).toHaveBeenCalledOnce();
    expect(events).toContain('error');
  });

  it('reports the installed packages on success', async () => {
    globals.sandboxData = { stack: 'REACT' };
    globals.activeSandboxProvider = {
      runCommand: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('{"dependencies":{"react":"19"}}'),
      installPackages: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'added 1', stderr: '' }),
      restartViteServer: vi.fn().mockResolvedValue(undefined),
    };

    const result = await installPackages({ packages: ['react', 'zod'] });
    expect(result).toMatchObject({
      ok: true,
      skipped: false,
      installedPackages: ['zod'],
      alreadyInstalled: ['react'],
    });
  });
});

describe('detectAndInstallPackages', () => {
  it('rejects a missing files object', async () => {
    expect(await detectAndInstallPackages({ files: undefined })).toEqual({
      ok: false,
      status: 400,
      error: 'Files object is required',
    });
  });

  it('reports a missing sandbox', async () => {
    expect(await detectAndInstallPackages({ files: {} })).toEqual({
      ok: false,
      status: 404,
      error: 'No active sandbox',
    });
  });

  it('ignores relative imports and node builtins', async () => {
    globals.activeSandboxProvider = { runCommand: vi.fn() };
    const result = await detectAndInstallPackages({
      files: {
        'src/App.jsx': "import './styles.css';\nimport fs from 'fs';\nimport path from 'path';",
      },
    });
    expect(result).toMatchObject({ ok: true, message: 'No new packages to install' });
  });

  it('reports packages that failed to verify after install', async () => {
    const runCommand = vi
      .fn()
      // node_modules check for zod
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      // npm install
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'added',
        stderr: '',
      })
      // verify zod
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    globals.activeSandboxProvider = { runCommand };

    const result = await detectAndInstallPackages({
      files: { 'src/App.jsx': "import { z } from 'zod';" },
    });

    expect(result).toMatchObject({ ok: true, packagesInstalled: [], packagesFailed: ['zod'] });
  });
});

describe('readSandboxFiles', () => {
  it('returns a failure result rather than throwing when there is no sandbox', async () => {
    expect(await readSandboxFiles()).toEqual({
      ok: false,
      status: 404,
      error: 'No active sandbox',
    });
  });

  it('logs a list failure and returns a typed 500 instead of throwing', async () => {
    globals.activeSandbox = {
      runCommand: vi.fn().mockRejectedValue(new Error('find failed')),
    };
    const result = await readSandboxFiles();
    expect(result).toEqual({ ok: false, status: 500, error: 'find failed' });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('restartDevServer', () => {
  it('reports a missing sandbox', async () => {
    expect(await restartDevServer()).toEqual({ ok: false, status: 400, error: 'No active sandbox' });
  });

  it('does not restart twice while a restart is in flight', async () => {
    globals.activeSandbox = { restartViteServer: vi.fn() };
    globals.viteRestartInProgress = true;
    expect(await restartDevServer()).toMatchObject({ ok: true, restarted: false });
  });

  it('honours the cooldown', async () => {
    const restartViteServer = vi.fn();
    globals.activeSandbox = { restartViteServer };
    globals.lastViteRestartTime = Date.now();
    const result = await restartDevServer();
    expect(result).toMatchObject({ ok: true, restarted: false });
    expect(restartViteServer).not.toHaveBeenCalled();
  });

  it('clears the in-progress flag when the provider throws', async () => {
    globals.activeSandbox = {
      restartViteServer: vi.fn().mockRejectedValue(new Error('sandbox gone')),
    };
    const result = await restartDevServer();
    expect(result).toEqual({ ok: false, status: 500, error: 'sandbox gone' });
    expect(globals.viteRestartInProgress).toBe(false);
  });
});

describe('self identity', () => {
  it('treats a blank COOLIFY_APP_UUID as not configured', () => {
    expect(getSelfIdentity({ COOLIFY_APP_UUID: '   ' } as NodeJS.ProcessEnv).coolifyAppUuid).toBeNull();
    expect(getSelfIdentity({} as NodeJS.ProcessEnv).coolifyAppUuid).toBeNull();
  });

  it('trims a configured uuid and reports the release', () => {
    const identity = getSelfIdentity({
      COOLIFY_APP_UUID: ' abc-123 ',
      GIT_SHA: 'deadbeef',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(identity.coolifyAppUuid).toBe('abc-123');
    expect(identity.gitSha).toBe('deadbeef');
    expect(identity.environment).toBe('production');
    expect(identity.instanceId).toBeTruthy();
  });

  it('gives restart and rollback the same not-configured message', () => {
    expect(SELF_UUID_NOT_CONFIGURED).toContain('COOLIFY_APP_UUID');
    expect(SELF_UUID_NOT_CONFIGURED).toContain('not configured');
  });
});

const GENERATE_STREAM = path.join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts');

function matchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function catchForCall(source: string, callName: string): string[] {
  const needle = `await ${callName}(`;
  const blocks: string[] = [];
  let from = 0;
  while (from < source.length) {
    const callIdx = source.indexOf(needle, from);
    if (callIdx < 0) break;
    let lastTry: number | null = null;
    let search = 0;
    while (search < callIdx) {
      const tryIdx = source.indexOf('try {', search);
      if (tryIdx < 0 || tryIdx > callIdx) break;
      const open = source.indexOf('{', tryIdx);
      const close = matchingBrace(source, open);
      if (close > callIdx) lastTry = close;
      search = tryIdx + 4;
    }
    if (lastTry === null) {
      throw new Error(`no enclosing try for ${callName} at ${callIdx}`);
    }
    const after = source.slice(lastTry + 1);
    const catchOpenRel = after.search(/catch\s*\([^)]*\)\s*\{/);
    if (catchOpenRel < 0) {
      throw new Error(`no catch after try for ${callName} at ${callIdx}`);
    }
    const catchOpen = lastTry + 1 + after.indexOf('{', catchOpenRel);
    const catchClose = matchingBrace(source, catchOpen);
    blocks.push(source.slice(catchOpen, catchClose + 1));
    from = callIdx + needle.length;
  }
  return blocks;
}

describe('generate-ai-code-stream unexpected-throw job steps', () => {
  const source = readFileSync(GENERATE_STREAM, 'utf8');

  it('records analyze-edit-intent when analyzeEditIntent throws', () => {
    const catches = catchForCall(source, 'analyzeEditIntent');
    expect(catches.length).toBeGreaterThanOrEqual(2);
    for (const block of catches) {
      expect(block).toMatch(/recordJobStepFailure\(/);
      expect(block).toMatch(/key:\s*'analyze-edit-intent'/);
    }
  });

  it('records read-sandbox-files when readSandboxFiles throws', () => {
    const catches = catchForCall(source, 'readSandboxFiles');
    expect(catches.length).toBeGreaterThanOrEqual(2);
    for (const block of catches) {
      expect(block).toMatch(/recordJobStepFailure\(/);
      expect(block).toMatch(/key:\s*'read-sandbox-files'/);
    }
  });
});
