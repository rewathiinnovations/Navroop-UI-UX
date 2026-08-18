import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindStreamErrorCapture } from '../../lib/ai/empty-completion';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '../../lib/ai/failover';
import {
  TRUNCATION_INCOMPLETE_KEPT,
  collectRecoveredStreamText,
  truncationRecoveryFailureMessage,
  truncationRecoveryOutcome,
} from '../../lib/generation/truncation-recovery';

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

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

function recoveryBlock() {
  const source = readFileSync(routePath, 'utf8');
  const start = source.indexOf('Attempting to regenerate truncated files');
  const end = source.indexOf("message: 'Truncation recovery complete'");
  return source.slice(start, end === -1 ? source.length : end);
}

describe('truncation-recovery streamText must not swallow a rejected call', () => {
  it('collectRecoveredStreamText throws the captured AI_APICallError instead of returning empty text', async () => {
    const apiError = unregisteredCallerError();
    const capture = bindStreamErrorCapture();
    const result = capture.attach({
      textStream: (async function* () {
        capture.onError({ error: apiError });
      })(),
      text: Promise.resolve(''),
    });

    await expect(collectRecoveredStreamText(result)).rejects.toBe(apiError);
    expect(jobErrorCodeForProviderFailure(apiError)).toBe('provider_not_configured');
    expect(jobErrorCodeForProviderFailure(apiError)).not.toBe('no_files_generated');
  });

  it('a failed recovery after truncation keeps the files and names the classified cause', () => {
    const apiError = unregisteredCallerError();
    const outcome = truncationRecoveryOutcome(apiError, 'google');

    expect(outcome.keepTruncatedFiles).toBe(true);
    expect(outcome.complete).toBe(false);
    expect(outcome.errorCode).toBe('provider_not_configured');
    expect(outcome.errorMessage).toBe(`${TRUNCATION_INCOMPLETE_KEPT} ${GEMINI_KEY_REJECTED}`);
    expect(outcome.errorMessage).toBe(truncationRecoveryFailureMessage(apiError, 'google'));
    expect(outcome.errorMessage).toMatch(/incomplete/i);
    expect(outcome.errorMessage).toMatch(/truncated files were kept/i);
    expect(providerFailureMessage(apiError, 'google')).toBe(GEMINI_KEY_REJECTED);
  });

  it('the generate route recovery streamText binds onError the same way as the main path', () => {
    const block = recoveryBlock();
    expect(block).toMatch(/bindStreamErrorCapture\(/);
    expect(block).toMatch(/onError:\s*capture\.onError/);
    expect(block).toMatch(/collectRecoveredStreamText\(/);
    expect(block).toMatch(/truncationRecoveryOutcome\(/);
    expect(block).not.toMatch(/Truncation recovery complete/);
  });
});
