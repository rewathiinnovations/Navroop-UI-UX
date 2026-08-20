import { describe, expect, it } from 'vitest';
import { safeFetch } from '@/lib/security/safe-fetch';
import { UnsafeUrlError } from '@/lib/security/url-guard';
import type { PinnedTransport } from '@/lib/security/pinned-fetch';

/**
 * F-317: `isAcceptedContentType` returned `true` when the header was absent and
 * again when the mime parsed to an empty string, so the allowlist that exists to
 * keep arbitrary binaries out of the import pipeline was bypassed by omitting the
 * header. Silence is not a pass on an allowlist.
 */

/** Keeps the SSRF guard off real DNS; the one hostname resolves public. */
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Returns a body with exactly the headers the test asks for — no more. */
function transportWith(headers: Record<string, string>): PinnedTransport {
  return async () => {
    const response = new Response(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), { status: 200 });
    // `new Response(body)` synthesises a Content-Type; strip it so "the origin
    // sent no Content-Type" is actually what the guard sees.
    response.headers.delete('content-type');
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
}

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof UnsafeUrlError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('safeFetch content-type allowlist', () => {
  it('rejects a response that declares no Content-Type', async () => {
    expect(
      await reason(
        safeFetch('https://example.com/payload.bin', {
          lookup,
          transport: transportWith({}),
        }),
      ),
    ).toBe('content_type');
  });

  it('rejects a Content-Type whose mime parses to nothing', async () => {
    expect(
      await reason(
        safeFetch('https://example.com/payload.bin', {
          lookup,
          transport: transportWith({ 'content-type': '; charset=utf-8' }),
        }),
      ),
    ).toBe('content_type');
  });

  it('rejects a declared, unrecognised type', async () => {
    expect(
      await reason(
        safeFetch('https://example.com/payload.bin', {
          lookup,
          transport: transportWith({ 'content-type': 'application/octet-stream' }),
        }),
      ),
    ).toBe('content_type');
  });

  it('still accepts the declared types the import pipeline needs', async () => {
    for (const mime of ['text/html', 'text/plain', 'text/css', 'application/json', 'image/webp']) {
      const response = await safeFetch('https://example.com/page', {
        lookup,
        transport: transportWith({ 'content-type': `${mime}; charset=utf-8` }),
      });
      expect(response.status).toBe(200);
    }
  });
});
