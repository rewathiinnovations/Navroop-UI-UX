import { describe, expect, it } from 'vitest';
import {
  evaluateRepoGuard,
  PublishRepoConflictError,
  repoConflictMessage,
} from '@/lib/publish/repo-guard';

/**
 * F-202: `ensureDeployRepo` used to adopt any same-named org repository and the trees
 * push then force-moved `main`, so a project slug colliding with an unrelated repo
 * silently replaced that repo's contents. The guard decides, before anything is pushed,
 * whether the publish target is a repo this project may write to:
 *
 * - a repo the ensure call just created is ours by construction;
 * - a recorded `Deployment.githubRepoId` must match the repo's immutable id;
 * - a pre-feature deployment (no recorded id) that already pushed to this exact repo
 *   adopts the id once instead of refusing;
 * - anything else refuses, and the refusal names the repo and the way forward.
 */

const REPO = { fullName: 'deploy-org/acme', repoId: '424242', created: false };

describe('evaluateRepoGuard', () => {
  it('refuses an existing repo when nothing records this project ever owning it', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: null,
      recordedRepoFullName: null,
      hasPushedBefore: false,
    });
    expect(decision).toEqual({ action: 'refuse', reason: 'unowned' });
  });

  it('refuses when the recorded id does not match — the repo was replaced under the name', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: '111',
      recordedRepoFullName: 'deploy-org/acme',
      hasPushedBefore: true,
    });
    expect(decision).toEqual({ action: 'refuse', reason: 'mismatch' });
  });

  it('proceeds when the recorded id matches the existing repo', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: '424242',
      recordedRepoFullName: 'deploy-org/acme',
      hasPushedBefore: true,
    });
    expect(decision).toEqual({ action: 'proceed' });
  });

  it('adopts a pre-feature repo this deployment already pushed to, instead of refusing', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: null,
      recordedRepoFullName: 'deploy-org/acme',
      hasPushedBefore: true,
    });
    expect(decision).toEqual({ action: 'adopt' });
  });

  it('does not adopt on the recorded name alone — a pre-feature adoption that never pushed is not ownership', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: null,
      recordedRepoFullName: 'deploy-org/acme',
      hasPushedBefore: false,
    });
    expect(decision).toEqual({ action: 'refuse', reason: 'unowned' });
  });

  it('does not adopt when the row points at a different repo name', () => {
    const decision = evaluateRepoGuard({
      repo: REPO,
      recordedRepoId: null,
      recordedRepoFullName: 'deploy-org/other',
      hasPushedBefore: true,
    });
    expect(decision).toEqual({ action: 'refuse', reason: 'unowned' });
  });

  it('always proceeds with a repo the ensure call just created', () => {
    const created = { ...REPO, created: true };
    // Even a recorded id from a vanished predecessor does not block a repo we just made.
    expect(
      evaluateRepoGuard({
        repo: created,
        recordedRepoId: '111',
        recordedRepoFullName: 'deploy-org/acme',
        hasPushedBefore: true,
      }),
    ).toEqual({ action: 'proceed' });
    expect(
      evaluateRepoGuard({
        repo: created,
        recordedRepoId: null,
        recordedRepoFullName: null,
        hasPushedBefore: false,
      }),
    ).toEqual({ action: 'proceed' });
  });
});

describe('PublishRepoConflictError', () => {
  it('names the repo, why publish stopped, and how to proceed', () => {
    const error = new PublishRepoConflictError('deploy-org/acme');
    expect(error.repoFullName).toBe('deploy-org/acme');
    expect(error.message).toBe(repoConflictMessage('deploy-org/acme'));
    expect(error.message).toContain('deploy-org/acme');
    expect(error.message).toContain('was not created by this project');
    expect(error.message).toContain('Replace existing repository');
    // The confirm phrase is the bare repo name, so the message must spell it out.
    expect(error.message).toContain('"acme"');
  });
});
