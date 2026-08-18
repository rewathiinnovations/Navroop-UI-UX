import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAndInstallPackages } from '@/lib/sandbox/detect-packages';

/**
 * bindLegacyGlobals sets `activeSandboxProvider` and the provider's
 * `runCommand` takes a string. This file used to read `global.activeSandbox`
 * and call `runCommand({ cmd, args })` — a path that cannot work.
 */

type Mutable = Record<string, unknown>;
const globals = globalThis as unknown as Mutable;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  delete globals.activeSandbox;
  delete globals.activeSandboxProvider;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectAndInstallPackages uses the live provider binding', () => {
  it('does not treat a leftover activeSandbox as the provider', async () => {
    globals.activeSandbox = {
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    };

    const result = await detectAndInstallPackages({
      files: { 'src/App.jsx': "import { z } from 'zod';" },
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'No active sandbox' });
    expect(globals.activeSandbox.runCommand).not.toHaveBeenCalled();
  });

  it('calls runCommand with a string, not { cmd, args }', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command.includes('test -d')) return { exitCode: 1, stdout: '', stderr: '' };
      if (command.startsWith('npm install')) return { exitCode: 0, stdout: 'added', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    });
    globals.activeSandboxProvider = { runCommand };

    const result = await detectAndInstallPackages({
      files: { 'src/App.jsx': "import { z } from 'zod';" },
    });

    expect(runCommand.mock.calls.length).toBeGreaterThan(0);
    for (const args of runCommand.mock.calls) {
      expect(typeof args[0]).toBe('string');
    }
    expect(result).toMatchObject({ ok: true, packagesInstalled: [], packagesFailed: ['zod'] });
  });

  it('reads stdout as a string on CommandResult, not a function', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command.includes('test -d')) return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: 'added 1 package', stderr: '' };
    });
    globals.activeSandboxProvider = { runCommand };

    // After install, verify still missing so we do not need a second success path.
    runCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'added 1 package', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });

    const result = await detectAndInstallPackages({
      files: { 'src/App.jsx': "import { z } from 'zod';" },
    });

    expect(result).toMatchObject({
      ok: true,
      packagesFailed: ['zod'],
      logs: 'added 1 package',
    });
  });
});
