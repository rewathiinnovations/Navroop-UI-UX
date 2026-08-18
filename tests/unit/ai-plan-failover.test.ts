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

const deepseekQuota = httpError(
  429,
  'You exceeded your current quota. Please check your plan and billing details',
);

const samplePlan = {
  summary: 'A bakery site',
  pages: [{ name: 'Home', description: 'Landing' }],
  keyFeatures: ['Menu'],
};

const env = {
  DEEPSEEK_API_KEY: 'test-deepseek',
};

describe('plan path runs through the shared provider helper', () => {
  it('produces a plan from the single configured provider', async () => {
    const called: string[] = [];
    const result = await completeWithProviderFailover({
      env,
      circuit: createCircuitBreaker(),
      run: async (entry) => {
        called.push(entry.provider);
        return samplePlan;
      },
    });

    expect(called).toEqual(['deepseek']);
    expect(result.provider).toBe('deepseek');
    expect(result.result).toEqual(samplePlan);
    expect(result.failedOver).toBe(false);
  });

  it('records quota exhaustion, not an unresponsive service, when the provider is out', async () => {
    try {
      await completeWithProviderFailover({
        env,
        circuit: createCircuitBreaker(),
        run: async () => {
          throw deepseekQuota;
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
      expect(message).toMatch(/plan and billing details/);
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
