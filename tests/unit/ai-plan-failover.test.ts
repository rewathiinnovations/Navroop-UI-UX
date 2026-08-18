import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { completeWithProviderFailover } from '../../lib/ai/plan-complete';
import { createCircuitBreaker } from '../../lib/ai/circuit';
import {
  classifyProviderFailure,
  jobErrorCodeForProviderFailure,
  providerFailureMessage,
} from '../../lib/ai/failover';
import { ProviderRunError } from '../../lib/ai/run';
import { recoveryCauseLine } from '../../lib/jobs/copy';

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

const geminiQuota = httpError(
  429,
  'You exceeded your current quota. generate_content_free_tier_requests limit 20',
);

const samplePlan = {
  summary: 'A bakery site',
  pages: [{ name: 'Home', description: 'Landing' }],
  keyFeatures: ['Menu'],
};

const env = {
  GEMINI_API_KEY: 'test-gemini',
  OPENAI_API_KEY: 'test-openai',
  GROQ_API_KEY: '',
};

describe('plan path uses the same provider failover', () => {
  it('switches from Gemini 429 quota to OpenAI and produces a plan', async () => {
    const called: string[] = [];
    const result = await completeWithProviderFailover({
      requestedModel: 'google/gemini-2.5-flash',
      env,
      circuit: createCircuitBreaker(),
      run: async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'google') throw geminiQuota;
        return samplePlan;
      },
    });

    expect(called).toEqual(['google', 'openai']);
    expect(result.provider).toBe('openai');
    expect(result.result).toEqual(samplePlan);
    expect(result.failedOver).toBe(true);
  });

  it('records quota exhaustion, not an unresponsive service, when every provider is out', async () => {
    try {
      await completeWithProviderFailover({
        requestedModel: 'google/gemini-2.5-flash',
        env,
        circuit: createCircuitBreaker(),
        run: async () => {
          throw geminiQuota;
        },
      });
      expect.fail('expected ProviderRunError');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRunError);
      const cause = (error as ProviderRunError).causeError;
      expect(classifyProviderFailure(cause)).toBe('quota');
      expect(jobErrorCodeForProviderFailure(cause)).toBe('provider_quota_exhausted');
      const message = providerFailureMessage(cause);
      expect(message).toMatch(/quota/i);
      expect(message).toMatch(/generate_content_free_tier_requests/);
      expect(message.toLowerCase()).not.toMatch(/did not respond|is down/);
      expect(recoveryCauseLine('provider_quota_exhausted')).toMatch(/quota/i);
      expect(recoveryCauseLine('provider_quota_exhausted').toLowerCase()).not.toMatch(
        /did not respond|the last build/,
      );
    }
  });

  it('the plan module routes its AI call through the shared failover helper', () => {
    const source = readFileSync(
      path.join(fileURLToPath(new URL('../../', import.meta.url)), 'lib/projects/plan.ts'),
      'utf8',
    );
    expect(source).toMatch(/completeWithProviderFailover\(/);
    expect(source).toMatch(/jobErrorCodeForProviderFailure\(/);
    expect(source).not.toMatch(/errorCode:\s*['"]provider_error['"]/);
  });
});
