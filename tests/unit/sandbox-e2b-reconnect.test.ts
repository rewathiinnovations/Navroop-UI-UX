import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import {
  sandboxMissingPreviewUrlMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
} from '@/lib/sandbox/boot-errors';

/**
 * E2B `reconnect` used to `catch { return false }`, so a timeout, 500, or
 * expired token looked like "the sandbox is gone". The caller then marked
 * the row dead and billed a new VM. `false` is only for evidence the
 * sandbox is gone; anything else throws. Mocked SDK — no live VM.
 */

const fake = vi.hoisted(() => {
  const state: {
    host: string | undefined;
    connectError: Error | null;
  } = {
    host: '5173-sb-e2b-live-1.e2b.dev',
    connectError: null,
  };
  return {
    state,
    reset() {
      state.host = '5173-sb-e2b-live-1.e2b.dev';
      state.connectError = null;
    },
  };
});

vi.mock('@e2b/code-interpreter', () => ({
  Sandbox: {
    async connect() {
      if (fake.state.connectError) throw fake.state.connectError;
      return {
        sandboxId: 'sb-e2b-live-1',
        getHost() {
          return fake.state.host;
        },
        setTimeout() {
          /* no-op */
        },
      };
    },
  },
  SandboxNotFoundError: class SandboxNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SandboxNotFoundError';
    }
  },
}));

const { E2BProvider, isE2BSandboxGone } = await import('@/lib/sandbox/providers/e2b-provider');
const { SandboxNotFoundError } = await import('@e2b/code-interpreter');

describe('isE2BSandboxGone — only positive evidence of absence', () => {
  it('treats SandboxNotFoundError, 404, and 410 as gone', () => {
    expect(isE2BSandboxGone(new SandboxNotFoundError('Sandbox not found'))).toBe(true);
    expect(isE2BSandboxGone(Object.assign(new Error('missing'), { statusCode: 404 }))).toBe(true);
    expect(isE2BSandboxGone(Object.assign(new Error('gone'), { statusCode: 410 }))).toBe(true);
    expect(isE2BSandboxGone(new Error('Sandbox 404 Not Found'))).toBe(true);
    expect(isE2BSandboxGone(null)).toBe(false);
  });

  it('does not treat timeouts, auth, file-not-found, or connection failures as gone', () => {
    expect(isE2BSandboxGone(new Error('ECONNRESET'))).toBe(false);
    expect(isE2BSandboxGone(new Error('E2B probe timed out'))).toBe(false);
    expect(isE2BSandboxGone(new Error('Unauthorized'))).toBe(false);
    const fileMissing = new Error('app/page.tsx not readable');
    fileMissing.name = 'FileNotFoundError';
    expect(isE2BSandboxGone(fileMissing)).toBe(false);
  });
});

describe('E2BProvider.reconnect — gone vs could not tell', () => {
  beforeEach(() => {
    fake.reset();
  });

  it('an uncertain E2B reconnect must not report gone', async () => {
    fake.state.connectError = new Error('ECONNRESET');
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    const expected = sandboxReconnectUncertainMessage('e2b', 'ECONNRESET');

    const result = await provider.reconnect('sb-e2b-live-1').then(
      (alive) => alive,
      (error: unknown) => error,
    );

    expect(result).not.toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toBe(`Error: ${expected}`);
    expect(expected).toMatch(/could not tell whether this sandbox is still running/i);
    expect(expected).toContain('E2B');
    expect(expected).toContain('/admin/sandbox-providers');
    expect(provider.isAlive()).toBe(false);
  });

  it('returns false when connect raises SandboxNotFoundError', async () => {
    fake.state.connectError = new SandboxNotFoundError('Sandbox not found');
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    await expect(provider.reconnect('sb-missing')).resolves.toBe(false);
    expect(provider.isAlive()).toBe(false);
  });

  it('throws the named uncertain error when the probe times out', async () => {
    fake.state.connectError = new Error('E2B probe timed out');
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    await expect(provider.reconnect('sb-e2b-live-1')).rejects.toThrow(
      sandboxReconnectUncertainMessage('e2b', 'E2B probe timed out'),
    );
    expect(provider.isAlive()).toBe(false);
  });

  it('throws the missing preview URL error when connect succeeds but getHost is empty — not false', async () => {
    fake.state.host = undefined;
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    const expected = sandboxReconnectMissingPreviewUrlMessage('e2b', appConfig.e2b.vitePort);
    expect(expected).not.toMatch(/created a sandbox/i);
    expect(expected).not.toMatch(/was stopped so it is not billed/i);
    expect(sandboxMissingPreviewUrlMessage('e2b', appConfig.e2b.vitePort)).toMatch(
      /created a sandbox/,
    );
    const result = await provider.reconnect('sb-e2b-live-1').then(
      (alive) => alive,
      (error: unknown) => error,
    );
    expect(result).not.toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toBe(`Error: ${expected}`);
    expect(provider.isAlive()).toBe(false);
  });

  it('returns true with a real preview URL when connect and getHost succeed', async () => {
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    await expect(provider.reconnect('sb-e2b-live-1')).resolves.toBe(true);
    expect(provider.getSandboxUrl()).toBe('https://5173-sb-e2b-live-1.e2b.dev');
    expect(provider.isAlive()).toBe(true);
  });
});

