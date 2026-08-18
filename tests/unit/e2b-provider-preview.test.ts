import { describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import { sandboxMissingPreviewUrlMessage } from '@/lib/sandbox/boot-errors';

/**
 * E2B builds the preview URL as `https://${getHost(vitePort)}`. A missing host
 * used to become the string `https://undefined`, which is truthy, so Test and
 * the 5-minute probe treated a broken sandbox as healthy. No live VM.
 */

const vitePort = appConfig.e2b.vitePort;
const STOPPED = { status: 'stopped' as const, sandboxId: 'sb-e2b-live-1' };
const LEAKED = {
  status: 'could_not_stop' as const,
  reason: 'kill refused',
  sandboxId: 'sb-e2b-live-1',
};
const MISSING_PREVIEW_URL = sandboxMissingPreviewUrlMessage('e2b', vitePort, STOPPED);
const MISSING_PREVIEW_URL_LEAKED = sandboxMissingPreviewUrlMessage('e2b', vitePort, LEAKED);

const fake = vi.hoisted(() => {
  const state: {
    sandboxId: string;
    host: string | undefined;
    killCalls: number;
    killError: Error | null;
  } = {
    sandboxId: 'sb-e2b-live-1',
    host: '5173-sb-e2b-live-1.e2b.dev',
    killCalls: 0,
    killError: null,
  };

  return {
    state,
    reset() {
      state.sandboxId = 'sb-e2b-live-1';
      state.host = '5173-sb-e2b-live-1.e2b.dev';
      state.killCalls = 0;
      state.killError = null;
    },
    sandbox: {
      get sandboxId() {
        return state.sandboxId;
      },
      getHost(_port: number) {
        return state.host;
      },
      setTimeout(_ms: number) {
        /* no-op — createSandbox may call this after a real host */
      },
      async kill() {
        state.killCalls += 1;
        if (state.killError) throw state.killError;
      },
    },
  };
});

vi.mock('@e2b/code-interpreter', () => ({
  Sandbox: {
    async create() {
      return fake.sandbox;
    },
    async connect() {
      return fake.sandbox;
    },
  },
}));

const { E2BProvider } = await import('@/lib/sandbox/providers/e2b-provider');

function liveProvider() {
  fake.reset();
  return new E2BProvider({ apiKey: 'e2b-not-real' });
}

describe('E2BProvider live preview URL', () => {
  it('returns https://host when getHost returns a real hostname', async () => {
    const provider = liveProvider();
    const created = await provider.createSandbox();

    expect(created.sandboxId).toBe('sb-e2b-live-1');
    expect(created.url).toBe('https://5173-sb-e2b-live-1.e2b.dev');
    expect(fake.state.killCalls).toBe(0);
    expect(provider.isAlive()).toBe(true);
  });

  it('fails by name and stops the VM when getHost is missing — not https://undefined', async () => {
    const provider = liveProvider();
    fake.state.host = undefined;

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL);
    expect(MISSING_PREVIEW_URL).toContain('The unused sandbox was stopped so it is not billed.');
    expect(MISSING_PREVIEW_URL).not.toContain('was asked to stop');
    expect(fake.state.killCalls).toBe(1);
    expect(provider.getSandboxUrl()).toBeNull();
    expect(provider.isAlive()).toBe(false);
    expect(provider.getSandboxUrl()).not.toBe('https://undefined');
  });

  it('keeps the missing-host cause and says the VM may still be billed when kill leaks', async () => {
    const provider = liveProvider();
    fake.state.host = undefined;
    fake.state.killError = new Error('kill refused');

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL_LEAKED);
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('did not return a preview URL');
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('The sandbox could not be shut down and may still be billed.');
    expect(MISSING_PREVIEW_URL_LEAKED).not.toContain('was asked to stop');
    expect(provider.isAlive()).toBe(true);
  });

  it('does not treat the literal host "undefined" as a preview URL', async () => {
    const provider = liveProvider();
    fake.state.host = 'undefined';

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL);
    expect(fake.state.killCalls).toBe(1);
    expect(provider.isAlive()).toBe(false);
  });
});
