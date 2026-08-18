import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fieldsAfterProviderTest,
  formatProviderTestResult,
} from '../../app/(app)/admin/sandbox-providers/provider-test';
import { applyPreviewUrlCheck } from '@/lib/sandbox/test-run';
import type { ProviderTestResult } from '@/lib/sandbox/test-run';

describe('formatProviderTestResult', () => {
  it('says a passing Test created a VM, ran echo, and shut it down — not that a preview or build works', () => {
    const line = formatProviderTestResult({
      driver: 'modal',
      ok: true,
      failedAt: null,
      error: null,
      previewUrl: 'https://preview.example.com',
    });
    expect(line).toBe(
      'Modal created a sandbox, ran echo, and shut it down. The preview URL was returned but not fetched. This does not start a preview or run a build.',
    );
  });

  it('names the driver, keeps the real failure, and gives a next step on each failed stage', () => {
    expect(
      formatProviderTestResult({
        driver: 'e2b',
        ok: false,
        failedAt: 'create',
        error: '401 unauthorized',
        previewUrl: null,
      }),
    ).toBe(
      'E2B could not create a sandbox (401 unauthorized). Check the credentials for this provider on /admin/sandbox-providers.',
    );
    expect(
      formatProviderTestResult({
        driver: 'daytona',
        ok: false,
        failedAt: 'command',
        error: 'Command failed',
        previewUrl: 'https://preview.example.com',
      }),
    ).toBe(
      'Daytona created a sandbox but the test command did not succeed (Command failed). The unused sandbox was asked to stop. Check the provider dashboard, then try Test again.',
    );
    expect(
      formatProviderTestResult({
        driver: 'modal',
        ok: false,
        failedAt: 'preview',
        error: 'Provider did not return a preview URL',
        previewUrl: null,
      }),
    ).toBe(
      'Modal created a sandbox and ran echo but returned no preview URL. This does not start a preview or run a build. Check the provider dashboard, then try Test again.',
    );
    expect(
      formatProviderTestResult({
        driver: 'e2b',
        ok: false,
        failedAt: 'preview',
        error: 'Provider returned an invalid preview URL (https://undefined)',
        previewUrl: 'https://undefined',
      }),
    ).toBe(
      'E2B created a sandbox and ran echo but returned an invalid preview URL (https://undefined). This does not start a preview or run a build. Check the provider dashboard, then try Test again.',
    );
    expect(
      formatProviderTestResult({
        driver: 'e2b',
        ok: false,
        failedAt: 'kill',
        error: 'terminate refused',
        previewUrl: 'https://preview.example.com',
      }),
    ).toBe(
      'E2B created a sandbox and ran echo but could not shut the sandbox down (terminate refused). Check the provider dashboard for a running sandbox.',
    );
    expect(
      formatProviderTestResult({
        driver: 'modal',
        ok: false,
        failedAt: 'command',
        error: 'Command failed (sandbox kill also failed: terminate refused)',
        previewUrl: 'https://preview.example.com',
        leakedSandbox: { sandboxId: 'sb-leak-1', error: 'terminate refused' },
      }),
    ).toBe(
      'Modal created a sandbox but the test command did not succeed (Command failed (sandbox kill also failed: terminate refused)). The sandbox could not be shut down and may still be billed. Check the provider dashboard.',
    );
  });
});

describe('fieldsAfterProviderTest', () => {
  const now = new Date('2026-08-18T03:11:00.000Z');

  it('records healthy with a null lastError after create/echo/shutdown — not a preview claim', () => {
    const fields = fieldsAfterProviderTest({
      ok: true,
      consecutiveFails: 2,
      lastError: 'should not be stored on success',
      config: { cpu: 1, downUntil: '2026-08-18T03:20:00.000Z' },
      now,
    });
    expect(fields.healthStatus).toBe('healthy');
    expect(fields.consecutiveFails).toBe(0);
    expect(fields.lastError).toBeNull();
    expect(fields.lastCheckedAt).toBe(now);
    expect(fields.config.downUntil).toBeUndefined();
  });

  it('records the English lastError and moves the circuit on a failed Test', () => {
    const lastError =
      'Modal could not create a sandbox (401 unauthorized). Check the credentials for this provider on /admin/sandbox-providers.';
    const first = fieldsAfterProviderTest({
      ok: false,
      consecutiveFails: 0,
      lastError,
      config: { cpu: 1 },
      now,
    });
    expect(first.healthStatus).toBe('degraded');
    expect(first.consecutiveFails).toBe(1);
    expect(first.lastError).toBe(lastError);

    const opened = fieldsAfterProviderTest({
      ok: false,
      consecutiveFails: 2,
      lastError,
      config: { cpu: 1 },
      now,
    });
    expect(opened.healthStatus).toBe('down');
    expect(opened.consecutiveFails).toBe(3);
    expect(opened.config.downUntil).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());
  });
});

describe('applyPreviewUrlCheck — a truthy string is not a preview URL', () => {
  const fetchSpy = vi.fn();

  afterEach(() => {
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
  });

  function passing(previewUrl: string | null): ProviderTestResult {
    return {
      ok: true,
      failedAt: null,
      error: null,
      previewUrl,
      leakedSandbox: null,
      timings: { createMs: 1, commandMs: 1, killMs: 1 },
    };
  }

  it('still fails a missing preview URL and does not fetch', () => {
    vi.stubGlobal('fetch', fetchSpy);
    const result = applyPreviewUrlCheck(passing(null), 'e2b');
    expect(result).toMatchObject({
      ok: false,
      failedAt: 'preview',
      error: 'Provider did not return a preview URL',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty, unparseable, non-http, and undefined/null hostnames without fetching', () => {
    vi.stubGlobal('fetch', fetchSpy);
    for (const raw of ['', '   ', 'not a url', 'ftp://preview.example.com', 'https://undefined', 'https://null']) {
      const result = applyPreviewUrlCheck(passing(raw), 'e2b');
      expect(result.ok, raw).toBe(false);
      expect(result.failedAt, raw).toBe('preview');
      if (!raw.trim()) {
        expect(result.error, raw).toBe('Provider did not return a preview URL');
      } else {
        expect(result.error, raw).toBe(`Provider returned an invalid preview URL (${raw.trim()})`);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a real http(s) preview URL', () => {
    vi.stubGlobal('fetch', fetchSpy);
    const https = applyPreviewUrlCheck(passing('https://preview.example.com'), 'e2b');
    const http = applyPreviewUrlCheck(passing('http://preview.example.com'), 'modal');
    expect(https).toMatchObject({ ok: true, previewUrl: 'https://preview.example.com' });
    expect(http).toMatchObject({ ok: true, previewUrl: 'http://preview.example.com' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
