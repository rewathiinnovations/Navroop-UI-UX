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
  it('builds the chain from the requested model via requireUsableProviderChain', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/requireUsableProviderChain\(/);
    expect(source).toMatch(/requestedModel:\s*model/);
    expect(source).toMatch(/errorCode:\s*['"]provider_not_configured['"]/);
    expect(source).toMatch(/loadEffectiveProviderEnv\(/);
    expect(source).toMatch(/executeWithCompletionFailover\(/);
  });

  it('fails the job with sandbox_unavailable instead of warning-and-continuing', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/errorCode:\s*['"]sandbox_unavailable['"]/);
    expect(source).not.toMatch(/console\.warn\(\s*['"]\[generate-ai-code-stream\] ensureSandbox failed/);
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

  it('tells the user once when the build continues on the fallback', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/failoverNotice\(/);
    expect(source).toMatch(/type:\s*['"]info['"]/);
  });

  it('captures streamText onError so a rejected call is not an empty textStream', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/bindStreamErrorCapture\(/);
    expect(source).toMatch(/onError:\s*capture\.onError/);
    expect(source).toMatch(/capture\.attach\(/);
  });
});
