/**
 * Try again on a failed import must not start a build.
 *
 * Fetch is mocked at the client boundary. No Firecrawl, no Playwright, no loopback.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_ACCESS_MESSAGE } from '@/lib/import/errors';
import { IMPORT_NO_FILES_MESSAGE } from '@/lib/import/copy';
import { URL_GUARD_MESSAGES } from '@/lib/security/url-guard';
import {
  KEEP_BUILT_LABEL,
  TRY_AGAIN_LABEL,
  keepActionLabel,
  offersRecoveryKeep,
  offersRecoveryRetry,
  recoveryNextStepLine,
} from '@/lib/jobs/copy';
import {
  dispatchRecoveryRetry,
  resolveImportRetrySource,
  recoveryRetryIntent,
} from '@/lib/jobs/recovery-retry';

const PROJECT_WORKSPACE = path.join(process.cwd(), 'components/workspace/ProjectWorkspace.tsx');
const RECOVERY_PANEL = path.join(process.cwd(), 'components/workspace/RecoveryPanel.tsx');
const GENERATION_PAGE = path.join(process.cwd(), 'app/generation/page.tsx');

const SOURCE = 'https://example.com/shop';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Try again on a failed import must not start a build', () => {
  it('dispatches an import of the recorded URL and mode, never a build', async () => {
    const startImport = vi.fn(async () => undefined);
    const startBuild = vi.fn(async () => undefined);
    const createRetryJob = vi.fn();

    const intent = recoveryRetryIntent({
      kind: 'IMPORT',
      errorCode: 'provider_error',
      sourceUrl: SOURCE,
      importMode: 'replicate',
      inputPrompt: SOURCE,
    });
    expect(intent.action).toBe('import');
    if (intent.action !== 'import') throw new Error('expected import intent');
    expect(intent.sourceUrl).toBe(SOURCE);
    expect(intent.mode).toBe('replicate');

    await dispatchRecoveryRetry(intent, { startImport, startPlan: vi.fn(), startBuild, createRetryJob });

    expect(startImport).toHaveBeenCalledTimes(1);
    expect(startImport).toHaveBeenCalledWith({ sourceUrl: SOURCE, mode: 'replicate' });
    expect(startBuild).not.toHaveBeenCalled();
    expect(createRetryJob).not.toHaveBeenCalled();
  });

  it('uses the job prompt when the workspace has no sourceUrl yet', () => {
    const source = resolveImportRetrySource({
      sourceUrl: null,
      importMode: 'reimagine',
      inputPrompt: SOURCE,
    });
    expect(source).toEqual({ sourceUrl: SOURCE, mode: 'reimagine' });
  });

  it('the workspace handleRetry does not call onStartApprovedBuild for IMPORT', () => {
    const source = readFileSync(PROJECT_WORKSPACE, 'utf8');
    expect(source).toMatch(/recoveryRetryIntent\(/);
    expect(source).toMatch(/dispatchRecoveryRetry\(/);
    expect(source).toMatch(/onRetryImport/);
    const retryFn = source.slice(source.indexOf('const handleRetry'), source.indexOf('const handleKeep'));
    expect(retryFn).toMatch(/intent\.action === 'import'/);
    expect(retryFn).not.toMatch(/if \(result\.prompt\) onStartApprovedBuild/);
  });

  it('the generation page retries through streamProjectImport, not startGeneration', () => {
    const source = readFileSync(GENERATION_PAGE, 'utf8');
    expect(source).toMatch(/onRetryImport=/);
    expect(source).toMatch(/streamProjectImport\(/);
    const retryBlock = source.slice(source.indexOf('onRetryImport='), source.indexOf('onThreadMessage='));
    expect(retryBlock).toMatch(/streamProjectImport\(/);
    expect(retryBlock).not.toMatch(/startGeneration\(/);
    expect(retryBlock).not.toMatch(/mode:\s*'build'/);
  });
});

describe('a retry that cannot work is not offered', () => {
  it('does not offer Try again for a blocked page, SSRF, or an unresolved host', () => {
    for (const errorMessage of [
      BLOCKED_ACCESS_MESSAGE,
      URL_GUARD_MESSAGES.private,
      URL_GUARD_MESSAGES.unresolved,
      URL_GUARD_MESSAGES.protocol,
      URL_GUARD_MESSAGES.credentials,
      URL_GUARD_MESSAGES.port,
      URL_GUARD_MESSAGES.content_type,
      URL_GUARD_MESSAGES.too_large,
      URL_GUARD_MESSAGES.redirect,
    ]) {
      expect(
        offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'import_failed', errorMessage }),
        errorMessage,
      ).toBe(false);
      expect(
        recoveryRetryIntent({
          kind: 'IMPORT',
          errorCode: 'import_failed',
          errorMessage,
          sourceUrl: SOURCE,
          importMode: 'reimagine',
        }).action,
        errorMessage,
      ).toBe('none');
    }
  });

  it('does not offer Try again when credits are gone or no provider is configured', () => {
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'credits_exhausted' })).toBe(false);
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'provider_not_configured' })).toBe(false);
    expect(offersRecoveryRetry({ kind: 'BUILD', errorCode: 'credits_exhausted' })).toBe(false);
  });

  it('still offers Try again for a transient import miss', () => {
    expect(
      offersRecoveryRetry({
        kind: 'IMPORT',
        errorCode: 'import_failed',
        errorMessage: IMPORT_NO_FILES_MESSAGE,
      }),
    ).toBe(true);
    expect(
      offersRecoveryRetry({
        kind: 'IMPORT',
        errorCode: 'import_failed',
        errorMessage: URL_GUARD_MESSAGES.timeout,
      }),
    ).toBe(true);
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'provider_error' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'timeout' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'client_disconnected' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'IMPORT', errorCode: 'provider_quota_exhausted' })).toBe(true);
  });

  it('names the next step when retry is not offered', () => {
    expect(
      recoveryNextStepLine({
        kind: 'IMPORT',
        errorCode: 'import_failed',
        errorMessage: BLOCKED_ACCESS_MESSAGE,
      }),
    ).toBe("This site blocked automated access. Paste the page content instead — trying the same URL will be blocked again.");
    expect(
      recoveryNextStepLine({
        kind: 'IMPORT',
        errorCode: 'import_failed',
        errorMessage: URL_GUARD_MESSAGES.private,
      }),
    ).toBe('This URL is on a private network and cannot be imported. Use a public page, or paste the content.');
    expect(
      recoveryNextStepLine({
        kind: 'IMPORT',
        errorCode: 'import_failed',
        errorMessage: URL_GUARD_MESSAGES.unresolved,
      }),
    ).toBe('This website could not be resolved. Check the address, or paste the page content.');
    expect(
      recoveryNextStepLine({ kind: 'IMPORT', errorCode: 'credits_exhausted' }),
    ).toBe("This month's credits are used up. Add credits, or wait for the monthly reset.");
  });

  it('the panel hides Try again when offersRecoveryRetry is false', () => {
    const source = readFileSync(RECOVERY_PANEL, 'utf8');
    expect(source).toMatch(/offerRetry/);
    expect(source).toMatch(/TRY_AGAIN_LABEL/);
  });
});

describe('Keep is not offered for an import', () => {
  it('filesWritten on an import is not a partial build to keep', () => {
    expect(offersRecoveryKeep({ kind: 'IMPORT', filesWritten: 4 })).toBe(false);
    expect(offersRecoveryKeep({ kind: 'IMPORT', filesWritten: 0 })).toBe(false);
    expect(offersRecoveryKeep({ kind: 'BUILD', filesWritten: 4 })).toBe(true);
    expect(offersRecoveryKeep({ kind: 'FOLLOWUP', filesWritten: 2 })).toBe(true);
    expect(offersRecoveryKeep({ kind: 'BUILD', filesWritten: 0 })).toBe(false);
    expect(offersRecoveryKeep({ kind: 'PLAN', filesWritten: 3 })).toBe(false);
  });

  it('does not reuse the build keep label for an import', () => {
    expect(keepActionLabel('IMPORT')).not.toBe(KEEP_BUILT_LABEL);
    expect(keepActionLabel('BUILD')).toBe(KEEP_BUILT_LABEL);
    expect(keepActionLabel('FOLLOWUP')).toBe(KEEP_BUILT_LABEL);
  });
});

describe('BUILD / FOLLOWUP Try again still starts the recorded job then a build', () => {
  it('BUILD and FOLLOWUP intents stay build', async () => {
    const startImport = vi.fn();
    const startBuild = vi.fn(async () => undefined);
    const createRetryJob = vi.fn(async () => ({ ok: true as const, prompt: 'rebuild the hero' }));

    await dispatchRecoveryRetry(
      recoveryRetryIntent({ kind: 'BUILD', errorCode: 'timeout', inputPrompt: 'rebuild the hero' }),
      { startImport, startPlan: vi.fn(), startBuild, createRetryJob },
    );
    expect(createRetryJob).toHaveBeenCalledTimes(1);
    expect(startBuild).toHaveBeenCalledWith('rebuild the hero');
    expect(startImport).not.toHaveBeenCalled();

    startBuild.mockClear();
    createRetryJob.mockClear();
    createRetryJob.mockResolvedValueOnce({ ok: true as const, prompt: 'make the nav sticky' });
    await dispatchRecoveryRetry(
      recoveryRetryIntent({ kind: 'FOLLOWUP', errorCode: 'provider_error', inputPrompt: 'make the nav sticky' }),
      { startImport, startPlan: vi.fn(), startBuild, createRetryJob },
    );
    expect(startBuild).toHaveBeenCalledWith('make the nav sticky');
    expect(startImport).not.toHaveBeenCalled();
  });

  it('PLAN Try again is a plan, not a build — see plan-recovery-retry.test.ts', async () => {
    const startImport = vi.fn();
    const startPlan = vi.fn(async () => undefined);
    const startBuild = vi.fn(async () => undefined);
    const createRetryJob = vi.fn();

    const intent = recoveryRetryIntent({
      kind: 'PLAN',
      errorCode: 'plan_failed',
      inputPrompt: 'a bakery site',
    });
    expect(intent.action).toBe('plan');

    await dispatchRecoveryRetry(intent, { startImport, startPlan, startBuild, createRetryJob });
    expect(startPlan).toHaveBeenCalledWith('a bakery site');
    expect(startBuild).not.toHaveBeenCalled();
    expect(createRetryJob).not.toHaveBeenCalled();
  });
});

describe('recovery panel copy helpers stay English', () => {
  it('Try again label is unchanged', () => {
    expect(TRY_AGAIN_LABEL).toBe('Try again');
  });
});
