/**
 * Try again on a failed plan must not start a build.
 *
 * Fetch is mocked at the client boundary. No AI calls, no sandbox, no loopback.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  START_OVER_LABEL,
  TRY_AGAIN_LABEL,
  offersRecoveryKeep,
  offersRecoveryRetry,
  recoveryNextStepLine,
} from '@/lib/jobs/copy';
import {
  dispatchRecoveryRetry,
  recoveryRetryIntent,
} from '@/lib/jobs/recovery-retry';
import { isChatBuilding, isChatLocked } from '@/lib/jobs/chat-ui';
import { NO_PROVIDER_CONFIGURED_MESSAGE } from '@/lib/ai/providers';
import { planRetryKind } from '@/lib/projects/plan-retry';
import { retryProjectPlan } from '@/lib/projects/plan-client';

const PROJECT_WORKSPACE = path.join(process.cwd(), 'components/workspace/ProjectWorkspace.tsx');
const RECOVERY_PANEL = path.join(process.cwd(), 'components/workspace/RecoveryPanel.tsx');
const GENERATION_PAGE = path.join(process.cwd(), 'components/workspace/GenerationWorkspace.tsx');

const PROMPT = 'a bakery site';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Try again on a failed plan must not start a build', () => {
  it('dispatches a plan of the recorded prompt, never a build', async () => {
    const startPlan = vi.fn(async () => undefined);
    const startBuild = vi.fn(async () => undefined);
    const startImport = vi.fn(async () => undefined);
    const createRetryJob = vi.fn();

    const intent = recoveryRetryIntent({
      kind: 'PLAN',
      errorCode: 'plan_failed',
      inputPrompt: PROMPT,
    });
    expect(intent.action).toBe('plan');
    if (intent.action !== 'plan') throw new Error('expected plan intent');
    expect(intent.prompt).toBe(PROMPT);

    await dispatchRecoveryRetry(intent, { startImport, startPlan, startBuild, createRetryJob });

    expect(startPlan).toHaveBeenCalledTimes(1);
    expect(startPlan).toHaveBeenCalledWith(PROMPT);
    expect(startBuild).not.toHaveBeenCalled();
    expect(createRetryJob).not.toHaveBeenCalled();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('the workspace handleRetry does not call onStartApprovedBuild for PLAN', () => {
    const source = readFileSync(PROJECT_WORKSPACE, 'utf8');
    expect(source).toMatch(/recoveryRetryIntent\(/);
    expect(source).toMatch(/dispatchRecoveryRetry\(/);
    expect(source).toMatch(/onRetryPlan/);
    const retryFn = source.slice(source.indexOf('const handleRetry'), source.indexOf('const handleKeep'));
    expect(retryFn).toMatch(/intent\.action === 'plan'/);
    expect(retryFn).not.toMatch(/if \(result\.prompt\) onStartApprovedBuild/);
  });

  it('the generation page retries through retryProjectPlan, not startGeneration', () => {
    const source = readFileSync(GENERATION_PAGE, 'utf8');
    expect(source).toMatch(/onRetryPlan=/);
    expect(source).toMatch(/retryProjectPlan\(/);
    const retryBlock = source.slice(source.indexOf('onRetryPlan='), source.indexOf('onThreadMessage='));
    expect(retryBlock).toMatch(/retryProjectPlan\(/);
    expect(retryBlock).not.toMatch(/startGeneration\(/);
    expect(retryBlock).not.toMatch(/mode:\s*'build'/);
  });

  it('retryProjectPlan POSTs the recorded prompt to the plan route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan: { id: 'plan_1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await retryProjectPlan({ projectId: 'proj_1', prompt: PROMPT });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/proj_1/plan');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: PROMPT });
  });

  it('the plan route POST retries through retryFailedPlan', () => {
    const source = readFileSync(path.join(process.cwd(), 'app/api/projects/[id]/plan/route.ts'), 'utf8');
    expect(source).toMatch(/export async function POST/);
    expect(source).toMatch(/retryFailedPlan/);
    expect(source).not.toMatch(/startInitialGeneration/);
  });
});

describe('a plan retry that cannot work is not offered', () => {
  it('does not offer Try again when credits are gone, no provider is configured, or the same prompt was rejected', () => {
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'credits_exhausted' })).toBe(false);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'provider_not_configured' })).toBe(false);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'request_rejected' })).toBe(false);
    expect(recoveryRetryIntent({ kind: 'PLAN', errorCode: 'request_rejected', inputPrompt: PROMPT }).action).toBe(
      'none',
    );
  });

  it('still offers Try again for a transient plan miss', () => {
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'plan_failed' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'provider_error' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'timeout' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'provider_quota_exhausted' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'client_disconnected' })).toBe(true);
    expect(offersRecoveryRetry({ kind: 'PLAN', errorCode: 'server_restarted' })).toBe(true);
  });

  it('names the next step when retry is not offered', () => {
    expect(recoveryNextStepLine({ kind: 'PLAN', errorCode: 'credits_exhausted' })).toBe(
      "This month's credits are used up. Add credits, or wait for the monthly reset.",
    );
    expect(recoveryNextStepLine({ kind: 'PLAN', errorCode: 'provider_not_configured' })).toBe(
      NO_PROVIDER_CONFIGURED_MESSAGE,
    );
    expect(recoveryNextStepLine({ kind: 'PLAN', errorCode: 'request_rejected' })).toBe(
      'The AI could not accept this request. Try a shorter prompt — sending the same one will be rejected again.',
    );
    expect(
      recoveryRetryIntent({ kind: 'PLAN', errorCode: 'timeout', inputPrompt: '' }).action,
    ).toBe('none');
    expect(recoveryRetryIntent({ kind: 'PLAN', errorCode: 'timeout', inputPrompt: '' })).toEqual({
      action: 'none',
      nextStep: 'We do not have the prompt for this plan. Type a new description to plan again.',
    });
  });
});

describe('Keep is not offered for a plan', () => {
  it('filesWritten on a plan is not a partial build to keep', () => {
    expect(offersRecoveryKeep({ kind: 'PLAN', filesWritten: 3 })).toBe(false);
    expect(offersRecoveryKeep({ kind: 'PLAN', filesWritten: 0 })).toBe(false);
    expect(offersRecoveryKeep({ kind: 'BUILD', filesWritten: 4 })).toBe(true);
  });

  it('the panel hides Keep for PLAN the same way it hides it for IMPORT', () => {
    const source = readFileSync(RECOVERY_PANEL, 'utf8');
    expect(source).toMatch(/kind !== 'IMPORT'/);
    expect(source).toMatch(/kind !== 'PLAN'/);
  });
});

describe('Start over stays available for a failed plan', () => {
  it('still wires Start over — a failed plan has no files, but the user can type a new description', () => {
    const workspace = readFileSync(PROJECT_WORKSPACE, 'utf8');
    expect(workspace).toMatch(/onStartOver: handleStartOver/);
    const panel = readFileSync(RECOVERY_PANEL, 'utf8');
    expect(panel).toMatch(/START_OVER_LABEL/);
    expect(START_OVER_LABEL).toBe('Start over');
    expect(TRY_AGAIN_LABEL).toBe('Try again');
  });
});

describe('a plan retry stays in planning and chat follows the job', () => {
  it('routes the retry onto the existing plan path for the current phase', () => {
    expect(planRetryKind('PLANNING')).toBe('initial');
    expect(planRetryKind(null)).toBe('initial');
    expect(planRetryKind('COMPLETE')).toBe('followup');
    expect(planRetryKind('BUILDING')).toBe('blocked');
  });

  it('locks chat while the plan job is in flight and unlocks on a terminal status', () => {
    expect(isChatBuilding({ phase: 'PLANNING', jobStatus: 'QUEUED' })).toBe(true);
    expect(isChatBuilding({ phase: 'PLANNING', jobStatus: 'RUNNING' })).toBe(true);
    expect(isChatLocked({ phase: 'PLANNING', jobStatus: 'RUNNING' })).toBe(true);
    expect(isChatBuilding({ phase: 'PLANNING', jobStatus: 'FAILED' })).toBe(false);
    expect(isChatLocked({ sending: true, phase: 'PLANNING', jobStatus: 'FAILED' })).toBe(false);
    expect(isChatLocked({ sending: true, phase: 'PLANNING', jobStatus: 'ABANDONED' })).toBe(false);
    expect(isChatLocked({ sending: true, phase: 'PLANNING', jobStatus: 'CANCELLED' })).toBe(false);
  });
});

