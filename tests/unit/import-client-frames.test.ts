/**
 * The import SSE `error` frame is `{ error: { message, code, requestId } }`
 * (`errorPayload`). The client used to read `payload.error` as a string, so a
 * blocked page or capture timeout rendered as `[object Object]` in chat — the
 * screen the user is watching.
 *
 * Fetch is mocked. No Firecrawl, no Playwright, no loopback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorPayload } from '@/lib/api/error-response';
import { BLOCKED_ACCESS_MESSAGE } from '@/lib/import/errors';
import { firecrawlFailureMessage } from '@/lib/import/firecrawl';
import { streamProjectImport } from '@/lib/import/client';

function sseResponse(frames: object[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('import SSE error frame is English, not [object Object]', () => {
  it('throws the blocked-page sentence from errorPayload, not String(object)', async () => {
    const frame = { type: 'error', ...errorPayload(BLOCKED_ACCESS_MESSAGE, 'IMPORT_FAILED', 'req_import_1') };
    expect(typeof frame.error).toBe('object');

    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([frame])));

    await expect(
      streamProjectImport({ projectId: 'proj_test', sourceUrl: 'https://example.com' }),
    ).rejects.toThrow(BLOCKED_ACCESS_MESSAGE);

    try {
      await streamProjectImport({ projectId: 'proj_test', sourceUrl: 'https://example.com' });
      throw new Error('expected streamProjectImport to reject');
    } catch (error) {
      const thrown = error instanceof Error ? error.message : String(error);
      expect(thrown).not.toBe('[object Object]');
      expect(thrown).not.toMatch(/\[object Object\]/);
      expect(thrown).toBe(BLOCKED_ACCESS_MESSAGE);
    }
  });
});

describe('other import client frames keep their real shape', () => {
  it('still delivers a progress sentence to onProgress', async () => {
    const english = firecrawlFailureMessage({ ok: false, reason: 'rate_limit', status: 429 });
    const progress: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { type: 'progress', message: english },
          {
            type: 'complete',
            filesXml: '<file path="app/page.tsx">ok</file>',
            warnings: [english],
            usedFallback: false,
            sourceUrl: 'https://example.com',
            mode: 'reimagine',
          },
        ]),
      ),
    );

    const result = await streamProjectImport({
      projectId: 'proj_test',
      sourceUrl: 'https://example.com',
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toEqual([english]);
    expect(result.filesXml).toContain('app/page.tsx');
    expect(result.warnings).toEqual([english]);
  });

  it('reads a string HTTP error body (SSRF 400) as that sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'This URL is on a private network and cannot be imported' }, 400)),
    );

    await expect(
      streamProjectImport({ projectId: 'proj_test', sourceUrl: 'http://127.0.0.1/' }),
    ).rejects.toThrow('This URL is on a private network and cannot be imported');
  });

  it('reads a nested HTTP errorPayload body as the message, not [object Object]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(errorPayload('Sign in required', 'UNAUTHORIZED', 'req_2'), 401)),
    );

    try {
      await streamProjectImport({ projectId: 'proj_test', sourceUrl: 'https://example.com' });
      throw new Error('expected streamProjectImport to reject');
    } catch (error) {
      const thrown = error instanceof Error ? error.message : String(error);
      expect(thrown).not.toBe('[object Object]');
      expect(thrown).toBe('Sign in required');
    }
  });
});
