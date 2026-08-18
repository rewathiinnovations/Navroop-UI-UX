import { describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import { sandboxMissingPreviewUrlMessage } from '@/lib/sandbox/boot-errors';

/**
 * Daytona opens a preview on demand via getPreviewLink(port). An empty or
 * missing URL must not be returned as a successful create — that is how a
 * half-created VM used to reach the workspace as "Sandbox created without a
 * preview URL" with the VM still running.
 */

const vitePort = appConfig.e2b.vitePort;
const STOPPED = { status: 'stopped' as const, sandboxId: 'sb-daytona-live-1' };
const LEAKED = {
  status: 'could_not_stop' as const,
  reason: 'delete refused',
  sandboxId: 'sb-daytona-live-1',
};
const MISSING_PREVIEW_URL = sandboxMissingPreviewUrlMessage('daytona', vitePort, STOPPED);
const MISSING_PREVIEW_URL_LEAKED = sandboxMissingPreviewUrlMessage('daytona', vitePort, LEAKED);

const fake = vi.hoisted(() => {
  const state: {
    id: string;
    previewUrl: string;
    previewError: Error | null;
    deleteCalls: number;
    deleteError: Error | null;
  } = {
    id: 'sb-daytona-live-1',
    previewUrl: 'https://preview.daytona.test',
    previewError: null,
    deleteCalls: 0,
    deleteError: null,
  };

  return {
    state,
    reset() {
      state.id = 'sb-daytona-live-1';
      state.previewUrl = 'https://preview.daytona.test';
      state.previewError = null;
      state.deleteCalls = 0;
      state.deleteError = null;
    },
    sandbox: {
      get id() {
        return state.id;
      },
      async getPreviewLink(port: number) {
        if (state.previewError) throw state.previewError;
        if (port !== vitePort) return { url: '' };
        return { url: state.previewUrl };
      },
      async delete() {
        state.deleteCalls += 1;
        if (state.deleteError) throw state.deleteError;
      },
    },
  };
});

vi.mock('@daytona/sdk', () => ({
  Daytona: class Daytona {
    constructor(_opts: { apiKey: string; apiUrl?: string }) {}
    async create() {
      return fake.sandbox;
    }
    async get() {
      return fake.sandbox;
    }
  },
}));

const { DaytonaProvider } = await import('@/lib/sandbox/providers/daytona-provider');

function liveProvider() {
  fake.reset();
  return new DaytonaProvider({ apiKey: 'not-a-real-key' });
}

describe('DaytonaProvider live preview URL', () => {
  it('returns the getPreviewLink URL for the Vite port', async () => {
    const provider = liveProvider();
    const created = await provider.createSandbox();

    expect(created.sandboxId).toBe('sb-daytona-live-1');
    expect(created.url).toBe('https://preview.daytona.test');
    expect(fake.state.deleteCalls).toBe(0);
  });

  it('fails by name and stops the sandbox when getPreviewLink has no URL', async () => {
    const provider = liveProvider();
    fake.state.previewUrl = '';

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL);
    expect(MISSING_PREVIEW_URL).toContain('The unused sandbox was stopped so it is not billed.');
    expect(MISSING_PREVIEW_URL).not.toContain('was asked to stop');
    expect(fake.state.deleteCalls).toBe(1);
    expect(provider.getSandboxUrl()).toBeNull();
    expect(provider.isAlive()).toBe(false);
  });

  it('keeps the missing-URL cause and says the VM may still be billed when delete leaks', async () => {
    const provider = liveProvider();
    fake.state.previewUrl = '';
    fake.state.deleteError = new Error('delete refused');

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL_LEAKED);
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('did not return a preview URL');
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('The sandbox could not be shut down and may still be billed.');
    expect(MISSING_PREVIEW_URL_LEAKED).not.toContain('was asked to stop');
    expect((provider as unknown as { live: unknown }).live).not.toBeNull();
  });
});
