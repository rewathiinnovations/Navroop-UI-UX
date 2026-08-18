import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaytonaProvider } from '@/lib/sandbox/providers/daytona-provider';
import { E2BProvider } from '@/lib/sandbox/providers/e2b-provider';
import { ModalProvider } from '@/lib/sandbox/providers/modal-provider';
import type { InjectedSandboxClient } from '@/lib/sandbox/provider';
import {
  previewNeverBecameReadyMessage,
  sandboxNpmInstallFailedMessage,
} from '@/lib/sandbox/boot-errors';
import { pollPreviewReady, SandboxBootError } from '@/lib/sandbox/manager';

/**
 * Pins the boot honesty the journey needs: a sandbox is not READY unless
 * `npm install` actually succeeded and the preview URL answers successfully
 * (2xx or 304).
 *
 * Injected Modal/Daytona clients and a fake E2B `runCode` handle — no live VM.
 */

const INSTALL_STDERR = 'npm ERR! ERESOLVE unable to resolve dependency tree';
const INSTALL_STOPPED = { status: 'stopped' as const, sandboxId: 'box-install-fail' };
const MODAL_INSTALL_FAILED = sandboxNpmInstallFailedMessage('modal', 1, INSTALL_STDERR, INSTALL_STOPPED);
const DAYTONA_INSTALL_FAILED = sandboxNpmInstallFailedMessage('daytona', 1, INSTALL_STDERR, INSTALL_STOPPED);
const E2B_INSTALL_FAILED = sandboxNpmInstallFailedMessage('e2b', 1, INSTALL_STDERR, {
  status: 'stopped',
  sandboxId: null,
});

const injectedBaseSource = readFileSync(
  join(process.cwd(), 'lib/sandbox/providers/injected-base.ts'),
  'utf8',
);
const e2bSource = readFileSync(join(process.cwd(), 'lib/sandbox/providers/e2b-provider.ts'), 'utf8');
const managerSource = readFileSync(join(process.cwd(), 'lib/sandbox/manager.ts'), 'utf8');

function failingInstallClient(): InjectedSandboxClient & {
  commands: string[];
  killCalls: number;
} {
  const commands: string[] = [];
  const client = {
    commands,
    killCalls: 0,
    create: async () => ({ id: 'box-install-fail', previewUrl: 'https://preview.example.test' }),
    run: async (command: string) => {
      commands.push(command);
      if (command === 'npm install' || command.startsWith('npm install ')) {
        return { stdout: '', stderr: INSTALL_STDERR, exitCode: 1 };
      }
      return { stdout: `ran:${command}`, stderr: '', exitCode: 0 };
    },
    writeFile: async () => undefined,
    readFile: async () => '',
    listFiles: async () => [],
    kill: async () => {
      client.killCalls += 1;
    },
    reconnect: async () => true,
    getPreviewUrl: () => 'https://preview.example.test',
  };
  return client;
}

describe('injected-base setupViteApp — npm install must not be treated as success', () => {
  it('hard-fails Modal setupViteApp on a non-zero install, names the command, and stops the VM', async () => {
    const client = failingInstallClient();
    const provider = new ModalProvider(
      { tokenId: 'ak-not-real', tokenSecret: 'as-not-real' },
      { client },
    );
    await provider.createSandbox('NEXTJS');

    await expect(provider.setupViteApp('NEXTJS')).rejects.toThrow(MODAL_INSTALL_FAILED);

    expect(client.killCalls).toBeGreaterThanOrEqual(1);
    expect(provider.isAlive()).toBe(false);
    expect(client.commands.some((command) => command.includes('next dev') || command.includes('vite'))).toBe(
      false,
    );
  });

  it('hard-fails Daytona setupViteApp the same way — it shares injected-base', async () => {
    const client = failingInstallClient();
    const provider = new DaytonaProvider({ apiKey: 'daytona-not-real' }, { client });
    await provider.createSandbox('NEXTJS');

    await expect(provider.setupViteApp('NEXTJS')).rejects.toThrow(DAYTONA_INSTALL_FAILED);
    expect(client.killCalls).toBeGreaterThanOrEqual(1);
    expect(provider.isAlive()).toBe(false);
  });

  it('hard-fails installAndStartDev (checkpoint restore) on a non-zero install', async () => {
    const client = failingInstallClient();
    const provider = new ModalProvider(
      { tokenId: 'ak-not-real', tokenSecret: 'as-not-real' },
      { client },
    );
    await provider.createSandbox('NEXTJS');

    await expect(provider.installAndStartDev('NEXTJS')).rejects.toThrow(MODAL_INSTALL_FAILED);
    expect(client.killCalls).toBeGreaterThanOrEqual(1);
    expect(client.commands.some((command) => command.includes('next dev'))).toBe(false);
  });

  it('does not swallow the install exit code in injected-base', () => {
    expect(injectedBaseSource).toMatch(/assertInstallSucceeded|exitCode !== 0|!.*\.success/);
    expect(injectedBaseSource).not.toMatch(
      /await this\.runCommand\(plan\.installCommand\);\s*\n\s*await this\.runCommand\(`\$\{plan\.devCommand\} &`\)/,
    );
  });
});

describe('E2B setupViteApp — runCode install must raise, not warn', () => {
  function fakeE2B(runCode: (code: string) => Promise<{ logs: { stdout: string[]; stderr: string[] }; error?: { name: string; value: string } }>) {
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    const kill = vi.fn(async () => undefined);
    (provider as unknown as { sandbox: { runCode: typeof runCode; kill: typeof kill } }).sandbox = {
      runCode,
      kill,
    };
    return { provider, kill };
  }

  it('throws the named install error and stops the VM when REACT npm install fails', async () => {
    const { provider, kill } = fakeE2B(async (code) => {
      if (code.includes("['npm', 'install']")) {
        return {
          logs: { stdout: [], stderr: [INSTALL_STDERR] },
          error: { name: 'RuntimeError', value: `npm install failed: ${INSTALL_STDERR}` },
        };
      }
      return { logs: { stdout: ['ok'], stderr: [] } };
    });

    await expect(provider.setupViteApp('REACT')).rejects.toThrow(E2B_INSTALL_FAILED);
    expect(kill).toHaveBeenCalled();
  });

  it('throws the named install error when a registry-stack install fails', async () => {
    const { provider, kill } = fakeE2B(async (code) => {
      if (code.includes('["npm","install"]') || code.includes("['npm', 'install']")) {
        return {
          logs: { stdout: [], stderr: [INSTALL_STDERR] },
          error: { name: 'RuntimeError', value: `npm install failed: ${INSTALL_STDERR}` },
        };
      }
      return { logs: { stdout: ['ok'], stderr: [] } };
    });

    await expect(provider.setupViteApp('NEXTJS')).rejects.toThrow(E2B_INSTALL_FAILED);
    expect(kill).toHaveBeenCalled();
  });

  it('no longer prints a warning and continues after a failed install', () => {
    expect(e2bSource).not.toMatch(/⚠ Warning: npm install had issues/);
    expect(e2bSource).toMatch(/raise RuntimeError\('npm install failed:/);
  });
});

describe('pollPreviewReady timeout is not READY', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a named English error when the preview URL never becomes ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 }) as Response),
    );

    const expected =
      'Modal created a sandbox but the preview never became ready (Preview HTTP 502). The unused sandbox was asked to stop. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.';
    expect(previewNeverBecameReadyMessage('modal', 'Preview HTTP 502')).toBe(expected);
    expect(
      previewNeverBecameReadyMessage('modal', 'Preview HTTP 502', {
        status: 'stopped',
        sandboxId: 'sb-1',
      }),
    ).toBe(
      'Modal created a sandbox but the preview never became ready (Preview HTTP 502). The unused sandbox was stopped so it is not billed. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
    const leaked = previewNeverBecameReadyMessage('modal', 'Preview HTTP 502', {
      status: 'could_not_stop',
      reason: 'kill refused',
      sandboxId: 'sb-1',
    });
    expect(leaked).toContain('the preview never became ready (Preview HTTP 502)');
    expect(leaked).toContain('The sandbox could not be shut down and may still be billed.');
    expect(leaked).not.toContain('was asked to stop');
    await expect(
      pollPreviewReady('https://preview.example.test', 'req-poll-1', {
        driver: 'modal',
        timeoutMs: 30,
        intervalMs: 10,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(SandboxBootError);
      expect((error as SandboxBootError).step).toBe('ready');
      expect((error as SandboxBootError).message).toBe(expected);
      return true;
    });
  });

  it('throws when fetch itself fails for the whole poll window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('preview host refused connection');
      }),
    );

    await expect(
      pollPreviewReady('https://preview.example.test', 'req-poll-2', {
        driver: 'e2b',
        timeoutMs: 30,
        intervalMs: 10,
      }),
    ).rejects.toThrow(
      'E2B created a sandbox but the preview never became ready (preview host refused connection). The unused sandbox was asked to stop. Try again, or ask an admin to test the E2B provider on /admin/sandbox-providers.',
    );
  });

  it('returns when the preview answers HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );

    await expect(
      pollPreviewReady('https://preview.example.test', 'req-poll-3', {
        driver: 'daytona',
        timeoutMs: 200,
        intervalMs: 10,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns when the preview answers 204 or 304 — the same ready check as 200', async () => {
    for (const status of [204, 304]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: status >= 200 && status < 300, status }) as Response),
      );
      await expect(
        pollPreviewReady('https://preview.example.test', `req-poll-${status}`, {
          driver: 'modal',
          timeoutMs: 200,
          intervalMs: 10,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('bootProject only marks READY after pollPreviewReady, and a throw sets FAILED', () => {
    const coldStart = managerSource.slice(managerSource.indexOf('setStep(projectId, \'ready\')'));
    expect(coldStart).toMatch(
      /await pollPreviewReady\(\s*previewUrl,\s*requestId,\s*\{\s*driver:\s*selectedConfig\.driver/,
    );
    expect(coldStart.indexOf('await pollPreviewReady(')).toBeLessThan(coldStart.indexOf("sandboxStatus: 'READY'"));
    expect(coldStart.indexOf("sandboxStatus: 'READY'")).toBeLessThan(coldStart.lastIndexOf("sandboxStatus: 'FAILED'"));
    expect(managerSource).toMatch(/applySandboxBootTeardownOutcome\(/);
    expect(managerSource).toMatch(/previewLastError/);
  });
});
