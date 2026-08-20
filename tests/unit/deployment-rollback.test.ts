import { describe, expect, it } from 'vitest';
import {
  deploymentReleases,
  executeDeploymentRollback,
  planDeploymentRollback,
  rollbackCommitMessage,
  type DeploymentRollbackTarget,
} from '@/lib/publish/rollback';
import { ROLLBACK_CONFIRM_PHRASE } from '@/lib/deploy/rollback';

/**
 * F-264: rolling a published site back to the release before the broken one.
 *
 * The deploy repo's git history IS the release history — `pushFiles` builds a child
 * commit on `main` per publish (F-210), so every previous release is still reachable by
 * sha. Coolify selects one by `git_commit_sha` on the application; the redeploy endpoint
 * takes no release parameter, which is why the instance-level rollback had to pin first
 * (`lib/deploy/rollback.ts`) and why this one does too.
 *
 * What must be impossible:
 *  - deploying anything when the pin was refused or could not be read back — a rollback
 *    that redeploys the release it was asked to replace is the fake this engagement
 *    deleted from `executeCoolifyRollback` in wave 3;
 *  - pinning a sha the caller supplied but the deploy repo's history does not contain
 *    (`targetSha` arrives from a browser);
 *  - a one-click rollback: it replaces the live site, so it is type-to-confirm.
 */

const RELEASE_COMMITS = [
  { sha: 'ccc3333', message: 'Publish live acme', committedAt: '2026-08-20T10:00:00.000Z' },
  { sha: 'bbb2222', message: 'Publish live acme', committedAt: '2026-08-19T10:00:00.000Z' },
  { sha: 'aaa1111', message: 'Publish live acme', committedAt: '2026-08-18T10:00:00.000Z' },
];

const DEPLOYMENT = {
  id: 'dep-1',
  slug: 'acme',
  status: 'LIVE' as const,
  coolifyAppUuid: 'app-uuid-1',
  repoFullName: 'navroop-deploy/acme-live',
  repoBranch: 'main',
  commitSha: 'ccc3333',
};

function target(sha: string): DeploymentRollbackTarget {
  const release = deploymentReleases(RELEASE_COMMITS, DEPLOYMENT.commitSha).find(
    (row) => row.sha === sha,
  );
  if (!release) throw new Error(`test fixture: no release ${sha}`);
  return release;
}

describe('deploymentReleases', () => {
  it('marks the live release and orders newest first', () => {
    const releases = deploymentReleases(RELEASE_COMMITS, 'bbb2222');
    expect(releases.map((row) => row.sha)).toEqual(['ccc3333', 'bbb2222', 'aaa1111']);
    expect(releases.map((row) => row.isCurrent)).toEqual([false, true, false]);
  });

  it('marks nothing current when the row records no commit', () => {
    const releases = deploymentReleases(RELEASE_COMMITS, null);
    expect(releases.some((row) => row.isCurrent)).toBe(false);
  });
});

describe('planDeploymentRollback', () => {
  const base = {
    deployment: DEPLOYMENT,
    releases: deploymentReleases(RELEASE_COMMITS, DEPLOYMENT.commitSha),
    targetSha: 'bbb2222',
    confirmation: ROLLBACK_CONFIRM_PHRASE,
  };

  it('accepts a previous release with the phrase typed', () => {
    const plan = planDeploymentRollback(base);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.target.sha).toBe('bbb2222');
  });

  it('refuses without the confirmation phrase', () => {
    const plan = planDeploymentRollback({ ...base, confirmation: 'yes' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toContain(ROLLBACK_CONFIRM_PHRASE);
      expect(plan.status).toBe(422);
    }
  });

  it('refuses a sha the deploy history does not contain', () => {
    const plan = planDeploymentRollback({ ...base, targetSha: 'deadbee' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(422);
  });

  it('refuses the release that is already live', () => {
    const plan = planDeploymentRollback({ ...base, targetSha: 'ccc3333' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('already');
  });

  it('refuses when Coolify has no application recorded for the deployment', () => {
    const plan = planDeploymentRollback({
      ...base,
      deployment: { ...DEPLOYMENT, coolifyAppUuid: null },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(409);
  });

  it('refuses when no deploy repo is recorded, so there is no history to trust', () => {
    const plan = planDeploymentRollback({
      ...base,
      deployment: { ...DEPLOYMENT, repoFullName: null },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(409);
  });

  it('refuses while a build is still running', () => {
    const plan = planDeploymentRollback({
      ...base,
      deployment: { ...DEPLOYMENT, status: 'BUILDING' },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(409);
  });
});

describe('executeDeploymentRollback', () => {
  it('deploys nothing when Coolify refuses the pin', async () => {
    const calls: string[] = [];
    const result = await executeDeploymentRollback({
      appUuid: 'app-uuid-1',
      target: target('bbb2222'),
      pinCommit: async () => {
        calls.push('pin');
        return { ok: false as const, error: 'Coolify refused to pin (500).' };
      },
      startDeploy: async () => {
        calls.push('deploy');
        return { deploymentUuid: 'never' };
      },
    });
    expect(calls).toEqual(['pin']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Nothing was deployed');
  });

  it('deploys nothing when the pin does not read back as the target', async () => {
    const calls: string[] = [];
    const result = await executeDeploymentRollback({
      appUuid: 'app-uuid-1',
      target: target('bbb2222'),
      pinCommit: async () => {
        calls.push('pin');
        return { ok: false as const, error: 'Coolify still reports commit ccc3333.' };
      },
      startDeploy: async () => {
        calls.push('deploy');
        return { deploymentUuid: 'never' };
      },
    });
    expect(calls).toEqual(['pin']);
    expect(result.ok).toBe(false);
  });

  it('pins before it deploys, and reports the deployment it triggered', async () => {
    const calls: string[] = [];
    const result = await executeDeploymentRollback({
      appUuid: 'app-uuid-1',
      target: target('bbb2222'),
      pinCommit: async (appUuid, sha) => {
        calls.push(`pin:${appUuid}:${sha}`);
        return { ok: true as const, sha };
      },
      startDeploy: async (appUuid) => {
        calls.push(`deploy:${appUuid}`);
        return { deploymentUuid: 'coolify-dep-9' };
      },
    });
    expect(calls).toEqual(['pin:app-uuid-1:bbb2222', 'deploy:app-uuid-1']);
    expect(result).toEqual({ ok: true, sha: 'bbb2222', deploymentUuid: 'coolify-dep-9' });
  });

  it('reports the pin that survived when the deploy request fails, rather than claiming success', async () => {
    const result = await executeDeploymentRollback({
      appUuid: 'app-uuid-1',
      target: target('bbb2222'),
      pinCommit: async (_appUuid, sha) => ({ ok: true as const, sha }),
      startDeploy: async () => {
        throw new Error('Coolify 502 /api/v1/deploy');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('bbb2222');
      expect(result.error).toContain('Coolify');
    }
  });

  it('refuses a deployment Coolify would not name, because nothing could then verify it', async () => {
    const result = await executeDeploymentRollback({
      appUuid: 'app-uuid-1',
      target: target('bbb2222'),
      pinCommit: async (_appUuid, sha) => ({ ok: true as const, sha }),
      startDeploy: async () => ({ deploymentUuid: null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('did not return a deployment id');
  });
});

describe('rollbackCommitMessage', () => {
  it('names the release and its date, not just the sha', () => {
    const line = rollbackCommitMessage(target('aaa1111'));
    expect(line).toContain('aaa1111');
    expect(line).toContain('18 Aug 2026');
  });

  it('survives a commit with no date', () => {
    const line = rollbackCommitMessage({
      sha: 'aaa1111',
      shortSha: 'aaa1111',
      message: 'Publish live acme',
      committedAt: null,
      isCurrent: false,
    });
    expect(line).toContain('aaa1111');
    expect(line).not.toContain('Invalid');
  });
});
