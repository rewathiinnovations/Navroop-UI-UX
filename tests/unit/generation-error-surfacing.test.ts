/**
 * Every generation failure has to reach the person who asked for the build.
 *
 * F-008: the route's contract is `text/event-stream`, but 401 / 400 / 503 / 429 / 500
 * answer JSON. The client read `!response.ok` and threw `HTTP error! status: N`, throwing
 * away the one operator-actionable sentence in the product ("DeepSeek is not configured —
 * add an API key in Admin → Configuration").
 * F-038: the tool-validation branch sent a `warning` and skipped the `error` frame, so the
 * read loop ended with no terminal frame and the run looked like a transport drop.
 * F-041: the truncation-recovery call decided its temperature with a `gpt-5` test that can
 * never be true for a DeepSeek id, so `-pro` — which the main call is careful to exclude —
 * received one.
 * F-047: `withRecordedJob` filed every EXPORT / DOMAIN_VERIFY / TEMPLATE_THUMBNAIL failure
 * as `provider_error`, so /admin/jobs grouped a storage outage under the AI provider and
 * showed "The AI service did not respond".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfig } from '@/config/app.config';
import { temperatureForModel } from '@/lib/ai/temperature';
import { generationRequestErrorMessage } from '@/lib/generation/request-error';
import { jobErrorCodeFromError } from '@/lib/jobs/error-code';
import { JobCapError } from '@/lib/consumption/caps';
import { recoveryCauseLine } from '@/lib/jobs/copy';

function source(relative: string) {
  return readFileSync(path.join(process.cwd(), relative), 'utf8');
}

/**
 * Source with comments removed. The repo documents a fix by quoting the code it replaced,
 * so an "this string is gone" assertion has to look at the code and not at the comment
 * explaining why it went.
 */
function code(relative: string) {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const GENERATE_ROUTE = 'app/api/generate-ai-code-stream/route.ts';

describe('generationRequestErrorMessage reads the server sentence (F-008)', () => {
  it('uses the jsonError body shape', () => {
    expect(
      generationRequestErrorMessage(503, {
        error: { message: 'DeepSeek is not configured', code: 'PROVIDER_NOT_CONFIGURED' },
      }),
    ).toBe('DeepSeek is not configured');
  });

  it('uses the plain { error: string } shape the same route also returns', () => {
    expect(
      generationRequestErrorMessage(400, { success: false, error: 'Prompt is required' }),
    ).toBe('Prompt is required');
    expect(generationRequestErrorMessage(401, { error: 'Sign in required' })).toBe(
      'Sign in required',
    );
  });

  it('falls back to a sentence that names the status when the body says nothing', () => {
    for (const body of [null, undefined, {}, { error: {} }, { error: '   ' }, 'not json']) {
      const message = generationRequestErrorMessage(500, body);
      expect(message).toContain('500');
      // Never the bare `HTTP error! status: N` that discarded the server's message.
      expect(message).not.toMatch(/^HTTP error!/);
    }
  });

  it('is what the client throws on a non-OK response', () => {
    expect(source('lib/generation/generation-runtime.ts')).toMatch(
      /generationRequestErrorMessage\(/,
    );
    expect(code('lib/generation/generation-runtime.ts')).not.toContain(
      '`HTTP error! status: ${response.status}`',
    );
  });
});

describe('every stop of the stream worker sends an error frame (F-038)', () => {
  it('has no branch that warns instead of failing', () => {
    // The package-installation sentence described a subsystem that no longer exists and
    // was the only thing the user got when a run stopped this way.
    expect(code(GENERATE_ROUTE)).not.toContain('Package installation tool encountered an issue');
    const text = source(GENERATE_ROUTE);
    const catchAt = text.indexOf('Stream processing error:');
    expect(catchAt).toBeGreaterThan(0);
    const block = code(GENERATE_ROUTE).slice(
      code(GENERATE_ROUTE).indexOf('const isToolValidationError'),
    );
    // One unconditional error frame, not one arm of an if/else.
    expect(block).toMatch(/await sendProgress\(\{\s*type: 'error'/);
    expect(block).not.toMatch(/type: 'warning'[\s\S]{0,200}\} else \{/);
  });

  it('classifies a tool-call failure on the SDK error type, not a phrase in the message', () => {
    expect(code(GENERATE_ROUTE)).not.toContain(
      "errorMessage.includes('tool call validation failed')",
    );
    expect(source(GENERATE_ROUTE)).toMatch(/isToolCallValidationError\(/);
    // The typed code is still written to the job row, so its curated copy still applies.
    expect(source(GENERATE_ROUTE)).toMatch(/'tool_call_validation_failed'/);
  });
});

describe('one temperature decision for every provider call (F-041)', () => {
  it('withholds the temperature from a thinking-mode model', () => {
    expect(temperatureForModel('deepseek-v4-pro')).toBeUndefined();
    expect(temperatureForModel('deepseek-reasoner-pro')).toBeUndefined();
  });

  it('sends the configured temperature to every other model', () => {
    expect(temperatureForModel('deepseek-v4')).toBe(appConfig.ai.defaultTemperature);
    expect(temperatureForModel('deepseek-chat')).toBe(appConfig.ai.defaultTemperature);
  });

  it('is the only way the route decides a temperature', () => {
    const text = code(GENERATE_ROUTE);
    expect(text).not.toContain("startsWith('gpt-5')");
    expect(text).not.toMatch(/actualModel\.includes\('-pro'\)/);
    const calls = text.match(/temperatureForModel\(/g) ?? [];
    // Main stream, corrective ask, truncation recovery.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a recorded job failure is filed under what actually failed (F-047)', () => {
  it('does not call a storage or DNS failure a provider error', () => {
    expect(jobErrorCodeFromError(new Error('ECONNRESET writing to object storage'))).toBe(
      'internal_error',
    );
    expect(jobErrorCodeFromError(new Error('Cloudflare 500'))).toBe('internal_error');
    expect(jobErrorCodeFromError('a string')).toBe('internal_error');
  });

  it('respects a code the thrower already decided', () => {
    const cap = new JobCapError('job_cap_exceeded', 'too big', {
      tokensOut: 1,
      files: 1,
      bytes: 1,
    });
    expect(jobErrorCodeFromError(cap)).toBe('job_cap_exceeded');
    const carried = Object.assign(new Error('nope'), { errorCode: 'snapshot_unreadable' });
    expect(jobErrorCodeFromError(carried)).toBe('snapshot_unreadable');
    // An unknown string is not smuggled through as a code.
    const bogus = Object.assign(new Error('nope'), { errorCode: 'not_a_real_code' });
    expect(jobErrorCodeFromError(bogus)).toBe('internal_error');
  });

  it('has copy that does not blame the AI', () => {
    const line = recoveryCauseLine('internal_error');
    expect(line.length).toBeGreaterThan(0);
    expect(line.toLowerCase()).not.toMatch(/ai service|did not respond/);
  });

  it('is what withRecordedJob writes', () => {
    const text = code('lib/jobs/wrap.ts');
    expect(text).not.toMatch(/errorCode:\s*'provider_error'/);
    // The caller may classify; absent that, the thrown error decides and the neutral code
    // is the floor.
    expect(text).toMatch(/input\.classifyError \?\? jobErrorCodeFromError/);
  });
});
