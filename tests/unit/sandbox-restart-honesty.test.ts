import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restartDevServer } from '@/lib/sandbox/restart-dev';
import { previewRestartFailedMessage } from '@/lib/sandbox/boot-errors';
import { installPackages } from '@/lib/sandbox/install-packages';

/**
 * Pins mid-generation restart honesty: "restarted" means the preview answered
 * successfully (2xx or 304). A failed restart is a typed degraded result — the
 * VM stays up so generated files are not lost. No live sandbox.
 */

const PREVIEW_URL = 'https://preview.example.test';
const POLL = { timeoutMs: 30, intervalMs: 10 };

type Mutable = Record<string, unknown>;
const globals = globalThis as unknown as Mutable;

function mockProvider(overrides: Record<string, unknown> = {}) {
  const terminate = vi.fn(async () => undefined);
  return {
    driver: 'modal',
    restartViteServer: vi.fn().mockResolvedValue(undefined),
    getSandboxUrl: () => PREVIEW_URL,
    getSandboxInfo: () => ({
      sandboxId: 'box-restart-1',
      url: PREVIEW_URL,
      provider: 'modal' as const,
      createdAt: new Date(),
    }),
    terminate,
    isAlive: () => true,
    ...overrides,
  };
}

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RESTART_502 =
  'Modal restarted the preview but it never became ready (Preview HTTP 502). The generated code was saved. Refresh or try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.';
const RESTART_NO_URL =
  'Modal restarted the preview but it never became ready (No preview URL). The generated code was saved. Refresh or try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.';

describe('restartDevServer claims success only after a successful preview response', () => {
  it('does not claim success when restartViteServer returns but the preview never answers', async () => {
    const provider = mockProvider();
    globals.activeSandboxProvider = provider;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 }) as Response),
    );

    const result = await restartDevServer(POLL);

    expect(previewRestartFailedMessage('modal', 'Preview HTTP 502')).toBe(RESTART_502);
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: RESTART_502,
    });
    expect(provider.restartViteServer).toHaveBeenCalledOnce();
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(globals.lastViteRestartTime).toBeUndefined();
  });

  it('does not claim success when there is no preview URL to poll', async () => {
    const provider = mockProvider({
      getSandboxUrl: () => null,
      getSandboxInfo: () => null,
    });
    globals.activeSandboxProvider = provider;

    const result = await restartDevServer(POLL);

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: RESTART_NO_URL,
    });
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  it('claims success after the preview answers 200, and also 304', async () => {
    for (const status of [200, 304]) {
      const provider = mockProvider();
      globals.activeSandboxProvider = provider;
      globals.lastViteRestartTime = undefined;
      const fetchMock = vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
      }) as Response);
      vi.stubGlobal('fetch', fetchMock);

      const result = await restartDevServer(POLL);

      expect(result, String(status)).toEqual({
        ok: true,
        restarted: true,
        message: 'Vite restarted successfully',
      });
      expect(fetchMock).toHaveBeenCalled();
      expect(provider.terminate).not.toHaveBeenCalled();
    }
  });

  it('polls after the nohup fallback, not only after restartViteServer', async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const provider = mockProvider({
      restartViteServer: undefined,
      runCommand,
    });
    globals.activeSandboxProvider = provider;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 }) as Response),
    );

    const result = await restartDevServer(POLL);

    expect(runCommand).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(RESTART_502);
  });
});

describe('installPackages does not describe a dead preview as restarted', () => {
  it('keeps the install result when the preview never comes back, and does not emit complete/restarted', async () => {
    const restartViteServer = vi.fn().mockResolvedValue(undefined);
    globals.sandboxData = { stack: 'REACT', url: PREVIEW_URL };
    globals.activeSandboxProvider = mockProvider({
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
      readFile: vi.fn().mockResolvedValue('{"dependencies":{}}'),
      installPackages: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'added 1', stderr: '' }),
      restartViteServer,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 }) as Response),
    );

    const events: string[] = [];
    const messages: string[] = [];
    const result = await installPackages({
      packages: ['zod'],
      restart: POLL,
      onProgress: (event) => {
        events.push(event.type);
        messages.push(event.message);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      installedPackages: ['zod'],
      previewReady: false,
    });
    expect(result.ok === true && result.previewNotice).toBe(RESTART_502);
    expect(events).not.toContain('complete');
    expect(messages.some((message) => /dev server restarted/i.test(message))).toBe(false);
    expect(globals.activeSandboxProvider.terminate).not.toHaveBeenCalled();
  });
});
