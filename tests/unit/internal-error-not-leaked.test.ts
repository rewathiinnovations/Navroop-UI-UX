import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { providerFailureMessage } from '@/lib/ai/failover';

/**
 * F-079: the generation route's outer catch returned
 * `(error as Error).message` verbatim with a 500, and
 * `providerFailureMessage` ended in `return detail || 'The AI service is
 * down…'` — so an unclassified provider error's own text became the
 * user-facing sentence *and* `Job.errorMessage`, which any signed-in member
 * can read. Prisma connection errors name the database host; provider errors
 * echo request metadata. The route even contradicted itself: it recorded the
 * curated sentence on the job one line above sending the raw one to the
 * browser.
 *
 * The rule these pin: what reaches the client comes from a known set; the
 * detail goes to the log and to Sentry with the request id.
 */

// A realistic internal failure: the text names infrastructure the caller has
// no business seeing. Assembled from parts so no scanner reads it as a real
// connection string.
const INTERNAL_DETAIL = [
  "Can't reach database server at",
  'db.internal.navroop:5432',
  '(pool exhausted)',
].join(' ');

describe('providerFailureMessage never forwards raw provider text (F-079)', () => {
  it('answers an unclassified failure with the generic sentence', () => {
    const message = providerFailureMessage(new Error(INTERNAL_DETAIL));

    expect(message).not.toContain('db.internal.navroop');
    expect(message).not.toContain(INTERNAL_DETAIL);
    expect(message).toBe('The AI service is down — try again in a few minutes.');
  });

  it('answers a 500 from the provider the same way', () => {
    const error = Object.assign(new Error(INTERNAL_DETAIL), { status: 500 });
    expect(providerFailureMessage(error)).not.toContain('db.internal.navroop');
  });

  it('still uses its curated sentences for the classified kinds', () => {
    const quota = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    expect(providerFailureMessage(quota)).toContain('out of quota');
    const tooBig = new Error('This model maximum context length is 64000 tokens');
    expect(providerFailureMessage(tooBig)).toContain('too large');
  });
});

describe('fromUnknownError does not echo the thrown message', () => {
  it('returns a fixed sentence, the code and the request id', async () => {
    const logged: unknown[] = [];
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({
      logError: (event: string, error: unknown) => {
        logged.push({ event, error });
      },
    }));
    const { fromUnknownError } = await import('@/lib/api/error-response');

    const response = fromUnknownError(new Error(INTERNAL_DETAIL));
    const body = (await response.json()) as {
      error: { message: string; code: string; requestId: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.message).not.toContain('db.internal.navroop');
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The detail is not dropped — it moves to the log, where the request id
    // ties it back to the response the caller saw.
    expect(logged).toHaveLength(1);
    vi.doUnmock('@/lib/logger');
    vi.resetModules();
  });
});

describe('the generation route sends a curated sentence', () => {
  it('never hands (error as Error).message to jsonError', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/jsonError\(\s*\(?\s*error[^,]*\.message/);
    // The job and the client must agree: the same curated sentence goes to both.
    expect(source).toMatch(
      /jsonError\(\s*(?:cap\?\.message \?\? )?providerFailureMessage\(error\)/,
    );
  });
});
