import { describe, expect, it, vi } from 'vitest';
import { E2BProvider } from '@/lib/sandbox/providers/e2b-provider';
import { sandboxListUnreadableMessage } from '@/lib/sandbox/boot-errors';

/**
 * E2B `listFiles` used to `JSON.parse` stdout and `catch { return [] }`.
 * An empty tree then looked like "the sandbox has no files" and publish
 * fell through to an older checkpoint. Unparseable output is a typed failure.
 * No live VM — `runCode` is a fake handle.
 */

function fakeE2B(
  runCode: (code: string) => Promise<{
    logs: { stdout: string[]; stderr: string[] };
    error?: { name: string; value: string };
  }>,
) {
  const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
  const kill = vi.fn(async () => undefined);
  (provider as unknown as { sandbox: { runCode: typeof runCode; kill: typeof kill } }).sandbox = {
    runCode,
    kill,
  };
  return { provider, kill };
}

describe('E2BProvider.listFiles — unparseable output is not an empty tree', () => {
  it('returns the parsed paths when stdout is a JSON array of strings', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: { stdout: ['["app/page.tsx","app/layout.tsx"]'], stderr: [] },
    }));

    await expect(provider.listFiles()).resolves.toEqual(['app/page.tsx', 'app/layout.tsx']);
  });

  it('throws the named list error instead of [] when stdout is not JSON', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: { stdout: ['not-json'], stderr: [] },
    }));

    const failed = await provider.listFiles().then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(Array.isArray(failed)).toBe(false);
    expect(failed).toBeInstanceOf(Error);
    expect(String(failed)).toMatch(/^Error: /);
    expect(String(failed)).toContain('E2B could not list the files in the sandbox');
    expect(String(failed)).toMatch(/not valid JSON|Unexpected token/i);
    expect(String(failed)).toMatch(/Try again/);
    expect(String(failed)).toContain('/admin/sandbox-providers');
    expect(String(failed).toLowerCase()).not.toMatch(/build (failed|did not)/);
  });

  it('throws when stdout is a JSON object rather than an array of paths', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: { stdout: ['{"files":["app/page.tsx"]}'], stderr: [] },
    }));

    await expect(provider.listFiles()).rejects.toThrow(/E2B could not list the files/);
    await expect(provider.listFiles()).rejects.toThrow(/not a JSON array of paths/);
  });

  it('throws the Python error when runCode raised instead of printing a list', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: { stdout: [], stderr: ['boom'] },
      error: { name: 'RuntimeError', value: 'os.walk exploded' },
    }));

    await expect(provider.listFiles()).rejects.toThrow(sandboxListUnreadableMessage('e2b', 'os.walk exploded'));
  });
});
