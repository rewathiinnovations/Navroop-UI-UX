import { describe, expect, it } from 'vitest';
import { NO_FAILURE_REASON_RECORDED, deploymentFailure } from '@/lib/publish/failure-copy';

/**
 * What a failed deployment is allowed to tell the user (F-260).
 *
 * `Deployment.lastError`, `progressStep` and `buildLogUrl` have been serialised since
 * `serialize.ts` was written and `/deployments` rendered none of them: the table said
 * "Failed" beside a Redeploy button, so the only recovery was to press it and hope. Wave 3/4
 * made the row honest — publish polls the real per-deployment Coolify status, abandon settles
 * the row, and `markDeploymentFailed` writes the message without clearing the step it died on
 * — so the reason exists and this is the function that shapes it for both surfaces.
 *
 * The two rules that matter: a non-FAILED row must produce nothing (rendering a stale
 * `lastError` under a LIVE site is the lie this replaces), and a FAILED row with no recorded
 * reason must still say something actionable rather than render an empty paragraph.
 */

const FAILED = {
  status: 'FAILED' as const,
  progressStep: 'poll',
  lastError: 'Coolify 422 /api/v1/deploy',
  lastRequestId: 'req-1',
  buildLogUrl: 'https://coolify.example.test/application/app-1',
};

describe('deploymentFailure', () => {
  it('names the step the publish died on, not just "failed"', () => {
    const failure = deploymentFailure(FAILED);

    expect(failure?.headline).toBe('Failed at Build in progress');
  });

  it('carries the reason, the request id and the build log through', () => {
    expect(deploymentFailure(FAILED)).toEqual({
      headline: 'Failed at Build in progress',
      reason: 'Coolify 422 /api/v1/deploy',
      requestId: 'req-1',
      buildLogUrl: 'https://coolify.example.test/application/app-1',
    });
  });

  it('says so instead of rendering an empty reason when none was recorded', () => {
    const failure = deploymentFailure({ ...FAILED, lastError: null });

    expect(failure?.reason).toBe(NO_FAILURE_REASON_RECORDED);
    expect(failure?.reason.trim()).not.toBe('');
  });

  it('treats a whitespace-only reason as no reason', () => {
    expect(deploymentFailure({ ...FAILED, lastError: '   ' })?.reason).toBe(
      NO_FAILURE_REASON_RECORDED,
    );
  });

  it('falls back to a plain headline when the row never recorded a step', () => {
    expect(deploymentFailure({ ...FAILED, progressStep: null })?.headline).toBe('Publish failed');
  });

  it('does not invent a step name for a key the stepper does not know', () => {
    // `stepLabel` answers 'Publishing' for anything unknown; naming a step that does not
    // exist would be worse than not naming one.
    expect(deploymentFailure({ ...FAILED, progressStep: 'not-a-step' })?.headline).toBe(
      'Publish failed',
    );
  });

  it('reports nothing for a live deployment even when a previous attempt failed', () => {
    expect(deploymentFailure({ ...FAILED, status: 'LIVE' })).toBeNull();
  });

  it('reports nothing while the build is still running', () => {
    expect(deploymentFailure({ ...FAILED, status: 'BUILDING' })).toBeNull();
    expect(deploymentFailure({ ...FAILED, status: 'QUEUED' })).toBeNull();
  });

  it('reports nothing for a deployment the user stopped', () => {
    // STOPPED is a user action, not a failure; a stale `lastError` must not resurface as one.
    expect(deploymentFailure({ ...FAILED, status: 'STOPPED' })).toBeNull();
  });

  it('drops a blank build log url rather than rendering a dead link', () => {
    expect(deploymentFailure({ ...FAILED, buildLogUrl: '' })?.buildLogUrl).toBeNull();
    expect(deploymentFailure({ ...FAILED, lastRequestId: '' })?.requestId).toBeNull();
  });
});
