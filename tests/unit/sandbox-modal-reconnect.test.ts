import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import {
  sandboxMissingPreviewUrlMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
} from '@/lib/sandbox/boot-errors';

/**
 * Modal `reconnectLive` used to return false without looking the sandbox up.
 * modal@0.9.0 exposes `client.sandboxes.fromId(id)` to reattach; `fromId` is
 * local (it does not hit the network) and `tunnels()` is the existence + URL
 * check. `false` is only for NotFound / 404 / 410. Mocked SDK — no live VM.
 */

const fake = vi.hoisted(() => {
  const state: {
    fromIdError: Error | null;
    tunnels: Record<number, { url: string }>;
    tunnelsError: Error | null;
  } = {
    fromIdError: null,
    tunnels: { 5173: { url: 'https://preview.modal.example' } },
    tunnelsError: null,
  };
  return {
    state,
    reset() {
      state.fromIdError = null;
      state.tunnels = { 5173: { url: 'https://preview.modal.example' } };
      state.tunnelsError = null;
    },
  };
});

vi.mock('modal', () => {
  class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotFoundError';
    }
  }
  class SandboxTimeoutError extends Error {
    constructor(message = 'SandboxTimeoutError') {
      super(message);
      this.name = 'SandboxTimeoutError';
    }
  }
  return {
    NotFoundError,
    SandboxTimeoutError,
    ModalClient: class ModalClient {
      constructor(_opts: { tokenId: string; tokenSecret: string }) {}
      sandboxes = {
        async fromId(_sandboxId: string) {
          if (fake.state.fromIdError) throw fake.state.fromIdError;
          return {
            sandboxId: 'sb-modal-live-1',
            async tunnels() {
              if (fake.state.tunnelsError) throw fake.state.tunnelsError;
              return fake.state.tunnels;
            },
          };
        },
      };
    },
  };
});

const { ModalProvider, isModalSandboxGone } = await import('@/lib/sandbox/providers/modal-provider');
const { NotFoundError, SandboxTimeoutError } = await import('modal');

describe('isModalSandboxGone — only positive evidence of absence', () => {
  it('treats NotFoundError, 404, and 410 as gone', () => {
    expect(isModalSandboxGone(new NotFoundError('Sandbox not found'))).toBe(true);
    expect(isModalSandboxGone(Object.assign(new Error('missing'), { statusCode: 404 }))).toBe(true);
    expect(isModalSandboxGone(Object.assign(new Error('gone'), { statusCode: 410 }))).toBe(true);
    expect(isModalSandboxGone(null)).toBe(false);
  });

  it('does not treat timeouts or connection failures as gone', () => {
    expect(isModalSandboxGone(new SandboxTimeoutError('tunnels timed out'))).toBe(false);
    expect(isModalSandboxGone(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('ModalProvider.reconnect — gone vs could not tell', () => {
  beforeEach(() => {
    fake.reset();
  });

  it('does not report gone when the driver has not looked the sandbox up', async () => {
    // Pin: reconnect must call fromId. Always-false without a lookup is the old bug.
    const provider = new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
    await expect(provider.reconnect('sb-modal-live-1')).resolves.toBe(true);
    expect(provider.getSandboxUrl()).toBe('https://preview.modal.example');
  });

  it('returns false when fromId / tunnels raise NotFoundError', async () => {
    fake.state.tunnelsError = new NotFoundError('Sandbox not found');
    const provider = new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
    await expect(provider.reconnect('sb-missing')).resolves.toBe(false);
    expect(provider.isAlive()).toBe(false);
  });

  it('throws the named uncertain error when tunnels() times out', async () => {
    fake.state.tunnelsError = new SandboxTimeoutError('tunnels timed out');
    const provider = new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
    const expected = sandboxReconnectUncertainMessage('modal', 'tunnels timed out');
    await expect(provider.reconnect('sb-modal-live-1')).rejects.toThrow(expected);
    expect(expected).toMatch(/could not tell whether this sandbox is still running/i);
    expect(expected).toContain('Modal');
    expect(expected).toContain('/admin/sandbox-providers');
    expect(provider.isAlive()).toBe(false);
  });

  it('throws the missing preview URL error when tunnels() has no Vite port — not false', async () => {
    fake.state.tunnels = { 8080: { url: 'https://wrong-port.example.com' } };
    const provider = new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
    const expected = sandboxReconnectMissingPreviewUrlMessage('modal', appConfig.e2b.vitePort);
    expect(expected).not.toMatch(/created a sandbox/i);
    expect(expected).not.toMatch(/was stopped so it is not billed/i);
    expect(sandboxMissingPreviewUrlMessage('modal', appConfig.e2b.vitePort)).toMatch(
      /created a sandbox/,
    );
    const result = await provider.reconnect('sb-modal-live-1').then(
      (alive) => alive,
      (error: unknown) => error,
    );
    expect(result).not.toBe(false);
    expect(result).not.toBe(true);
    expect(String(result)).toBe(`Error: ${expected}`);
    expect(provider.getSandboxUrl()).toBeNull();
  });
});
