import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../lib/ai/circuit';
import {
  classifyProviderFailure,
  jobErrorCodeForProviderFailure,
  providerFailureMessage,
  shouldFailover,
} from '../../lib/ai/failover';
import { EmptyCompletionError, surfaceStreamFailure } from '../../lib/ai/empty-completion';
import {
  executeWithCompletionFailover,
  executeWithFailover,
  ProviderRunError,
} from '../../lib/ai/run';
import type { ProviderEntry } from '../../lib/ai/providers';
import { recoveryCauseLine } from '../../lib/jobs/copy';
import { describeNoChanges } from '../../lib/generation/no-changes';

function httpError(status: number, message = 'error') {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function unregisteredCallerError() {
  const error = new Error(
    "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
  ) as Error & { statusCode: number };
  error.name = 'AI_APICallError';
  error.statusCode = 403;
  return error;
}

const GEMINI_KEY_REJECTED =
  'DeepSeek rejected the API key. Ask an administrator to check the DeepSeek key, then try again.';

const FOLLOW_UP_NO_FILES =
  'No changes were made: the AI did not return any files for this request. Please try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';

const geminiThenOpenAI: ProviderEntry[] = [
  { id: 'google', provider: 'google', model: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' },
  { id: 'openai', provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
];

describe('shouldFailover distinguishes unusable providers from bad requests', () => {
  it('switches immediately on 401, 403 (invalid key), 404, 429, 5xx, and timeouts', () => {
    expect(shouldFailover(httpError(401, 'Invalid API key'))).toBe(true);
    expect(shouldFailover(httpError(403, 'Incorrect API key provided'))).toBe(true);
    expect(shouldFailover(httpError(404, 'model not found'))).toBe(true);
    expect(shouldFailover(httpError(429, 'rate limit exceeded'))).toBe(true);
    expect(shouldFailover(httpError(500, 'internal error'))).toBe(true);
    expect(shouldFailover(httpError(503, 'Service Unavailable'))).toBe(true);
    expect(shouldFailover(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(shouldFailover(new Error('fetch failed'))).toBe(true);
    expect(classifyProviderFailure(httpError(429))).toBe('quota');
    expect(
      classifyProviderFailure(
        new Error('You exceeded your current quota. generate_content_free_tier_requests'),
      ),
    ).toBe('quota');
  });

  it('switches on a zero-file completion', () => {
    expect(shouldFailover(new EmptyCompletionError('deepseek', 'deepseek-v4-flash'))).toBe(true);
  });

  it('does not switch on a malformed request, content-policy refusal, or context overflow', () => {
    expect(shouldFailover(httpError(400, 'invalid_request'))).toBe(false);
    expect(shouldFailover(httpError(403, 'content filter'))).toBe(false);
    expect(shouldFailover(httpError(400, 'content_filter'))).toBe(false);
    expect(shouldFailover(httpError(400, 'context length exceeded'))).toBe(false);
    expect(shouldFailover(httpError(400, 'maximum context'))).toBe(false);
    expect(classifyProviderFailure(httpError(403, 'content filter'))).toBe('content_policy');
    expect(classifyProviderFailure(httpError(400, 'context_length_exceeded'))).toBe(
      'context_length',
    );
  });
});

describe('executeWithFailover switches Gemini to OpenAI without waiting', () => {
  it('tries OpenAI after Gemini 401 and records OpenAI as the served provider', async () => {
    const called: string[] = [];
    const result = await executeWithFailover(
      geminiThenOpenAI,
      async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'google') throw httpError(401, 'Invalid API key');
        return { text: 'ok' };
      },
      { circuit: createCircuitBreaker() },
    );

    expect(called).toEqual(['google', 'openai']);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.failedOver).toBe(true);
    expect(result.attempts.map((row) => ({ provider: row.provider, ok: row.ok }))).toEqual([
      { provider: 'google', ok: false },
      { provider: 'openai', ok: true },
    ]);
  });

  it('tries OpenAI after Gemini 429 (quota) instead of sitting on the rate limit', async () => {
    const called: string[] = [];
    const result = await executeWithFailover(
      geminiThenOpenAI,
      async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'google') throw httpError(429, 'Too Many Requests');
        return { text: 'ok' };
      },
      { circuit: createCircuitBreaker() },
    );

    expect(called).toEqual(['google', 'openai']);
    expect(result.provider).toBe('openai');
    expect(result.failedOver).toBe(true);
  });

  it('tries OpenAI after Gemini 5xx or a hang, without a long backoff first', async () => {
    const called: string[] = [];
    const started = Date.now();
    const result = await executeWithFailover(
      geminiThenOpenAI,
      async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'google') {
          await new Promise((resolve) => setTimeout(resolve, 80));
          throw new Error('connect ETIMEDOUT');
        }
        return { text: 'ok' };
      },
      { circuit: createCircuitBreaker(), timeoutMs: 200 },
    );

    expect(called).toEqual(['google', 'openai']);
    expect(result.provider).toBe('openai');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('cuts a stalled provider attempt at the timeout and switches', async () => {
    const called: string[] = [];
    const started = Date.now();
    const result = await executeWithFailover(
      geminiThenOpenAI,
      async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'google') {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return { text: 'too late' };
        }
        return { text: 'ok' };
      },
      { circuit: createCircuitBreaker(), timeoutMs: 40 },
    );

    expect(called[0]).toBe('google');
    expect(called).toContain('openai');
    expect(result.provider).toBe('openai');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('tries OpenAI after Gemini returns zero files, and succeeds on the second', async () => {
    const called: string[] = [];
    const result = await executeWithCompletionFailover(
      geminiThenOpenAI,
      async (entry) => {
        called.push(entry.provider);
        return { provider: entry.provider };
      },
      async (started) => {
        if (started.provider === 'google') return { files: [] as { path: string }[] };
        return { files: [{ path: 'app/page.tsx' }] };
      },
      (collected) => collected.files.length > 0,
      { circuit: createCircuitBreaker() },
    );

    expect(called).toEqual(['google', 'openai']);
    expect(result.provider).toBe('openai');
    expect(result.result.files).toEqual([{ path: 'app/page.tsx' }]);
    expect(result.failedOver).toBe(true);
    expect(result.attempts.map((row) => ({ provider: row.provider, ok: row.ok }))).toEqual([
      { provider: 'google', ok: false },
      { provider: 'openai', ok: true },
    ]);
  });

  it('does not retry the same provider when every completion is empty', async () => {
    const called: string[] = [];
    await expect(
      executeWithCompletionFailover(
        geminiThenOpenAI,
        async (entry) => {
          called.push(entry.provider);
          return { provider: entry.provider };
        },
        async () => ({ files: [] as { path: string }[] }),
        (collected) => collected.files.length > 0,
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ProviderRunError);
      expect((error as ProviderRunError).causeError).toBeInstanceOf(EmptyCompletionError);
      return true;
    });
    expect(called).toEqual(['google', 'openai']);
  });

  it('does not try a second provider on content-policy or context-length failures', async () => {
    const called: string[] = [];
    await expect(
      executeWithFailover(
        geminiThenOpenAI,
        async (entry) => {
          called.push(entry.provider);
          throw httpError(403, 'content filter: request blocked');
        },
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toThrow(/content filter/i);
    expect(called).toEqual(['google']);

    called.length = 0;
    await expect(
      executeWithFailover(
        geminiThenOpenAI,
        async (entry) => {
          called.push(entry.provider);
          throw httpError(400, 'context length exceeded');
        },
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toThrow(/context length/i);
    expect(called).toEqual(['google']);
  });
});

describe('honest operator copy when every provider fails', () => {
  it('quota copy does not claim the AI service is down', () => {
    const line = recoveryCauseLine('provider_quota_exhausted');
    expect(line).toMatch(/quota/i);
    expect(line.toLowerCase()).not.toMatch(/did not respond|is down/);
    expect(line.length).toBeGreaterThan(0);
  });

  it('request-rejected copy names the prompt, not an outage', () => {
    const line = recoveryCauseLine('request_rejected');
    expect(line.toLowerCase()).toMatch(/prompt|content|large/);
    expect(line.toLowerCase()).not.toMatch(/did not respond|is down/);
    expect(line.length).toBeGreaterThan(0);
  });
});

describe('a rejected provider call is a credential failure, not an empty model', () => {
  it('surfaceStreamFailure returns a captured AI_APICallError instead of treating the stream as empty', async () => {
    const apiError = unregisteredCallerError();
    const cause = await surfaceStreamFailure({
      text: Promise.resolve(''),
      streamError: apiError,
    });
    expect(cause).toBe(apiError);
    expect(jobErrorCodeForProviderFailure(cause)).toBe('provider_not_configured');
    expect(jobErrorCodeForProviderFailure(cause)).not.toBe('no_files_generated');
  });

  it('an empty completion after a swallowed identity rejection is classified as a credential failure', async () => {
    const apiError = unregisteredCallerError();
    await expect(
      executeWithCompletionFailover(
        geminiThenOpenAI,
        async (entry) => {
          if (entry.provider === 'google') {
            return { text: Promise.resolve(''), streamError: apiError };
          }
          return { text: Promise.resolve(''), streamError: apiError };
        },
        async () => ({ files: [] as { path: string }[] }),
        (collected) => collected.files.length > 0,
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ProviderRunError);
      const cause = (error as ProviderRunError).causeError;
      expect(cause).toBe(apiError);
      expect(cause).not.toBeInstanceOf(EmptyCompletionError);
      expect(jobErrorCodeForProviderFailure(cause)).toBe('provider_not_configured');
      expect(jobErrorCodeForProviderFailure(cause)).not.toBe('no_files_generated');
      expect(providerFailureMessage(cause, 'google')).toBe(GEMINI_KEY_REJECTED);
      return true;
    });
  });

  it('names Gemini and addresses an administrator for a rejected credential', () => {
    expect(providerFailureMessage(unregisteredCallerError(), 'google')).toBe(GEMINI_KEY_REJECTED);
    expect(GEMINI_KEY_REJECTED).toMatch(/administrator/);
    expect(GEMINI_KEY_REJECTED.toLowerCase()).not.toMatch(/describe the change/);
  });

  it('classifies the Google unregistered-caller message as auth even without a status', () => {
    const nameless = new Error(
      "Method doesn't allow unregistered callers (callers without established identity).",
    );
    nameless.name = 'AI_APICallError';
    expect(classifyProviderFailure(nameless)).toBe('auth');
    expect(shouldFailover(nameless)).toBe(true);
    expect(jobErrorCodeForProviderFailure(nameless)).toBe('provider_not_configured');
  });

  it('keeps the follow-up-edit no-files wording for a genuine empty model', () => {
    expect(
      describeNoChanges({
        isEdit: true,
        hasProjectFiles: true,
        hasManifest: true,
        providersTried: ['Gemini'],
      }),
    ).toBe(FOLLOW_UP_NO_FILES);
  });

  it('still does not fail over on a genuine request-fault 4xx', async () => {
    const called: string[] = [];
    await expect(
      executeWithFailover(
        geminiThenOpenAI,
        async (entry) => {
          called.push(entry.provider);
          throw httpError(400, 'invalid_request');
        },
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toThrow(/invalid_request/);
    expect(called).toEqual(['google']);
    expect(shouldFailover(httpError(400, 'invalid_request'))).toBe(false);
    expect(jobErrorCodeForProviderFailure(httpError(400, 'invalid_request'))).toBe(
      'request_rejected',
    );
  });
});
