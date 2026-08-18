import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

function generateRouteSource() {
  return readFileSync(routePath, 'utf8');
}

describe('generate-ai-code-stream provider and sandbox preflight', () => {
  it('builds the chain from the optional requested model via requireUsableProviderChain', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/requireUsableProviderChain\(/);
    // The requested model is explicit-only: an omitted or blank body model must
    // reach the chain as undefined so the configured primary (AI_PRIMARY_* /
    // Admin → Configuration) leads. Defaulting it to appConfig.ai.defaultModel
    // used to silently demote that setting on every build.
    expect(source).toMatch(/\{\s*requestedModel\s*\}/);
    expect(source).not.toMatch(/requestedModel:\s*appConfig\.ai\.defaultModel/);
    // The concrete model used for logging derives from the chain that will serve.
    expect(source).toMatch(/requestedModel\s*\?\?\s*modelIdForEntry\(providerChain\[0\]\)/);
    expect(source).toMatch(/errorCode:\s*['"]provider_not_configured['"]/);
    expect(source).toMatch(/loadEffectiveProviderEnv\(/);
    expect(source).toMatch(/executeWithCompletionFailover\(/);
  });

  it('does not boot anything before generating', () => {
    // Generation writes files to the database and the browser renders them.
    // There is no workspace to start, so no pre-flight can fail the job.
    const source = generateRouteSource();
    expect(source).not.toMatch(/ensureSandbox\(/);
  });

  it('settles a streamed BUILD through settleStreamedGeneration, not a bare succeedJob', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/settleStreamedGeneration\(/);
    const settleAt = source.indexOf('settleStreamedGeneration({');
    expect(settleAt).toBeGreaterThan(0);
    const settleBlock = source.slice(settleAt, settleAt + 600);
    expect(settleBlock).toMatch(/producedFiles:\s*files\.length/);
    expect(source).not.toMatch(/await succeedJob\(generationJob\.id/);
  });

  it('does not wait on the rate-limit queue before switching providers', () => {
    const source = generateRouteSource();
    const failoverBlock = source.slice(
      source.indexOf('executeWithCompletionFailover'),
      source.indexOf('// Stream the response and parse in real-time'),
    );
    expect(failoverBlock).not.toMatch(/handleRateLimit/);
    expect(failoverBlock).not.toMatch(/retryCount \* 2000/);
  });

  it('tells the user once when the build had to be retried', () => {
    // One provider now, so the notice is about a retry rather than a vendor
    // switch — but the user still has to be told the first attempt failed.
    const source = generateRouteSource();
    expect(source).toMatch(/failover\.failedOver/);
    expect(source).toMatch(/type:\s*['"]info['"]/);
  });

  it('captures streamText onError so a rejected call is not an empty textStream', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/bindStreamErrorCapture\(/);
    expect(source).toMatch(/onError:\s*capture\.onError/);
    expect(source).toMatch(/capture\.attach\(/);
  });
});
