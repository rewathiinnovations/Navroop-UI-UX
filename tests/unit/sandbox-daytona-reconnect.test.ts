import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import {
  sandboxMissingPreviewUrlMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
} from '@/lib/sandbox/boot-errors';

/**
 * Daytona `reconnectLive` used to `catch { return false }`, so an API
 * timeout looked like "the sandbox is gone". That can bill a new VM or
 * tell the user the workspace is not running. `false` is only for
 * evidence the sandbox is gone; anything else throws.
 * Mocked SDK — no live VM.
 */

const fake = vi.hoisted(() => {
  const state: {
    existing: object | null;
    getError: Error | null;
    previewUrl: string;
    previewError: Error | null;
  } = {
    existing: { id: 'sb-daytona-live-1' },
    getError: null,
    previewUrl: 'https://preview.daytona.example',
    previewError: null,
  };
  return {
    state,
    reset() {
      state.existing = {
        id: 'sb-daytona-live-1',
        async getPreviewLink() {
          if (state.previewError) throw state.previewError;
          return { url: state.previewUrl };
        },
      };
      state.getError = null;
      state.previewUrl = 'https://preview.daytona.example';
      state.previewError = null;
    },
  };
});

vi.mock('@daytona/sdk', () => ({
  Daytona: class Daytona {
    constructor(_opts: { apiKey: string; apiUrl?: string }) {}
    async get(_id: string) {
      if (fake.state.getError) throw fake.state.getError;
      return fake.state.existing;
    }
  },
  DaytonaNotFoundError: class DaytonaNotFoundError extends Error {
    statusCode = 404;
    constructor(message: string) {
      super(message);
      this.name = 'DaytonaNotFoundError';
    }
  },
  DaytonaTimeoutError: class DaytonaTimeoutError extends Error {
    statusCode = 408;
    constructor(message: string) {
      super(message);
      this.name = 'DaytonaTimeoutError';
    }
  },
}));

const { DaytonaProvider, isDaytonaSandboxGone } = await import('@/lib/sandbox/providers/daytona-provider');
const { DaytonaNotFoundError, DaytonaTimeoutError } = await import('@daytona/sdk');

describe('isDaytonaSandboxGone — only positive evidence of absence', () => {
  it('treats DaytonaNotFoundError, 404, 410, and an empty get as gone', () => {
    expect(isDaytonaSandboxGone(new DaytonaNotFoundError('Sandbox not found'))).toBe(true);
    expect(isDaytonaSandboxGone(Object.assign(new Error('missing'), { statusCode: 404 }))).toBe(true);
    expect(isDaytonaSandboxGone(Object.assign(new Error('gone'), { statusCode: 410 }))).toBe(true);
    expect(isDaytonaSandboxGone(new Error('Sandbox 404 Not Found'))).toBe(true);
    expect(isDaytonaSandboxGone(null)).toBe(false);
  });

  it('does not treat timeouts or connection failures as gone', () => {
    expect(isDaytonaSandboxGone(new DaytonaTimeoutError('deadline exceeded'))).toBe(false);
    expect(isDaytonaSandboxGone(new Error('ECONNRESET'))).toBe(false);
    expect(isDaytonaSandboxGone(new Error('socket hang up'))).toBe(false);
  });
});

describe('DaytonaProvider.reconnect — gone vs could not tell', () => {
  beforeEach(() => {
    fake.reset();
  });

  it('returns false when get() finds nothing', async () => {
    fake.state.existing = null;
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await expect(provider.reconnect('sb-missing')).resolves.toBe(false);
    expect(provider.isAlive()).toBe(false);
  });

  it('returns false when get() raises DaytonaNotFoundError', async () => {
    fake.state.getError = new DaytonaNotFoundError('Sandbox not found');
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await expect(provider.reconnect('sb-missing')).resolves.toBe(false);
    expect(provider.isAlive()).toBe(false);
  });

  it('throws the named uncertain error when get() times out', async () => {
    fake.state.getError = new DaytonaTimeoutError('deadline exceeded');
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    const expected = sandboxReconnectUncertainMessage('daytona', 'deadline exceeded');
    await expect(provider.reconnect('sb-live')).rejects.toThrow(expected);
    expect(expected).toMatch(/could not tell whether this sandbox is still running/i);
    expect(expected).toContain('/admin/sandbox-providers');
    expect(expected.toLowerCase()).not.toMatch(/build (failed|did not)/);
    expect(provider.isAlive()).toBe(false);
  });

  it('throws when get() hits a connection error, not false', async () => {
    fake.state.getError = new Error('ECONNRESET');
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await expect(provider.reconnect('sb-live')).rejects.toThrow(
      sandboxReconnectUncertainMessage('daytona', 'ECONNRESET'),
    );
  });

  it('throws the missing preview URL error when getPreviewLink returns empty — not a successful reconnect', async () => {
    fake.state.previewUrl = '';
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    const expected = sandboxReconnectMissingPreviewUrlMessage('daytona', appConfig.e2b.vitePort);
    expect(expected).not.toMatch(/created a sandbox/i);
    expect(expected).not.toMatch(/was stopped so it is not billed/i);
    expect(sandboxMissingPreviewUrlMessage('daytona', appConfig.e2b.vitePort)).toMatch(
      /created a sandbox/,
    );
    const result = await provider.reconnect('sb-live').then(
      (alive) => alive,
      (error: unknown) => error,
    );
    expect(result).not.toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toBe(`Error: ${expected}`);
    expect(provider.getSandboxUrl()).toBeNull();
  });

  it('throws uncertain when getPreviewLink fails — not true with an empty URL', async () => {
    fake.state.previewError = new Error('preview link timed out');
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    const result = await provider.reconnect('sb-live').then(
      (alive) => alive,
      (error: unknown) => error,
    );
    expect(result).not.toBe(true);
    expect(provider.getSandboxUrl()).not.toBe('');
    await expect(provider.reconnect('sb-live')).rejects.toThrow(
      sandboxReconnectUncertainMessage('daytona', 'preview link timed out'),
    );
  });

  it('returns true with a real preview URL when get and getPreviewLink succeed', async () => {
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await expect(provider.reconnect('sb-live')).resolves.toBe(true);
    expect(provider.getSandboxUrl()).toBe('https://preview.daytona.example');
    expect(provider.isAlive()).toBe(true);
  });
});
