import type { DeploymentStatus } from '@/generated/prisma';
import { ROLLBACK_CONFIRM_PHRASE } from '@/lib/deploy/rollback';
import type { DeployCommit } from '@/lib/github/deploy-client';

/**
 * F-264 — roll a published site back to the release before the broken one.
 *
 * WHERE THE HISTORY COMES FROM
 * There is no deployment-history table: `Deployment` is one row per
 * (project, kind) and its `commitSha` is only ever the *current* release. The
 * history that does exist is the deploy repo's git log — `pushFiles` builds a
 * child commit on the deploy branch per publish and the force flag is opt-in and
 * unused (F-210), so every previously published release is still reachable by
 * sha. One commit on that branch = one publish, which makes the sha the natural
 * handle and needs no migration.
 *
 * WHY IT PINS FIRST
 * `GET /api/v1/deploy?uuid=…` is Coolify's *redeploy the current configuration*
 * endpoint; it takes no parameter naming a release. The parameter that selects
 * one is the application's `git_commit_sha`
 * (`PATCH /api/v1/applications/{uuid}`), which Coolify resolves the next deploy
 * to. So the order is: pin, prove the pin by reading it back, and only then
 * deploy. Every failure before the deploy returns `ok: false` having deployed
 * nothing — the instance-level twin of this shipped as a redeploy of the *broken*
 * release plus a success toast, and was rewritten for exactly this reason
 * (`lib/deploy/rollback.ts`).
 *
 * AFTERWARDS
 * The application stays pinned to the rolled-back sha. That is deliberate: an
 * unpinned application rebuilds whatever the branch head is, which is the release
 * the user just rejected. The next publish re-pins to the commit it pushes
 * (`lib/publish/execute.ts`, `pin` step), so rolling forward is "publish again"
 * and nothing silently ships the old release.
 */

/** One publish of this deployment, as recorded in the deploy repo. */
export type DeploymentRelease = {
  sha: string;
  shortSha: string;
  message: string;
  committedAt: string | null;
  /** The release the `Deployment` row says is live. */
  isCurrent: boolean;
};

export type DeploymentRollbackTarget = DeploymentRelease;

/** The `Deployment` columns a rollback reads. */
export type RollbackDeployment = {
  id: string;
  slug: string;
  status: DeploymentStatus;
  coolifyAppUuid: string | null;
  repoFullName: string | null;
  commitSha: string | null;
};

const SHORT_SHA = 7;

export function deploymentReleases(
  commits: DeployCommit[],
  currentSha: string | null,
): DeploymentRelease[] {
  return commits.map((commit) => ({
    sha: commit.sha,
    shortSha: commit.sha.slice(0, SHORT_SHA),
    message: commit.message,
    committedAt: commit.committedAt,
    isCurrent: Boolean(currentSha) && commit.sha === currentSha,
  }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formatted here rather than through `toLocaleDateString`: this string goes into
 * an audit entry and a toast, and both must read the same on a server whose ICU
 * data is trimmed.
 */
function releaseDate(iso: string | null) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getUTCDate()).padStart(2, '0')} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** "release aaa1111, published 18 Aug 2026" — the sha alone means nothing to a user. */
export function rollbackCommitMessage(target: DeploymentRelease) {
  const when = releaseDate(target.committedAt);
  return when ? `release ${target.shortSha}, published ${when}` : `release ${target.shortSha}`;
}

export type DeploymentRollbackPlan =
  { ok: true; target: DeploymentRelease } | { ok: false; error: string; status: 409 | 422 };

/**
 * `targetSha` arrives from a browser, so it is only ever accepted when it is one
 * of the commits actually on this deployment's deploy branch. Without that check
 * the endpoint would pin the application to any string the caller supplied and
 * deploy it.
 */
export function planDeploymentRollback(input: {
  deployment: RollbackDeployment;
  releases: DeploymentRelease[];
  targetSha: string;
  confirmation: string;
}): DeploymentRollbackPlan {
  if (input.confirmation.trim().toLowerCase() !== ROLLBACK_CONFIRM_PHRASE) {
    return {
      ok: false,
      error: `Type "${ROLLBACK_CONFIRM_PHRASE}" to confirm — this replaces the live site.`,
      status: 422,
    };
  }
  if (!input.deployment.coolifyAppUuid) {
    return {
      ok: false,
      error:
        'This deployment has no Coolify application recorded, so there is nothing to roll back. Publish it again first.',
      status: 409,
    };
  }
  if (!input.deployment.repoFullName) {
    return {
      ok: false,
      error:
        'This deployment has no deploy repository recorded, so its release history cannot be trusted. Publish it again first.',
      status: 409,
    };
  }
  if (input.deployment.status === 'BUILDING' || input.deployment.status === 'QUEUED') {
    return {
      ok: false,
      error:
        'A build is already running for this deployment. Wait for it to finish, then roll back.',
      status: 409,
    };
  }
  const target = input.releases.find((row) => row.sha === input.targetSha);
  if (!target) {
    return {
      ok: false,
      error:
        'That release is not in this site\u2019s deploy history, so it cannot be deployed. Reload the release list and pick one from it.',
      status: 422,
    };
  }
  if (target.isCurrent || target.sha === input.deployment.commitSha) {
    return { ok: false, error: 'That release is already live.', status: 422 };
  }
  return { ok: true, target };
}

/** Proven pin: `ok` means Coolify read the sha back, not merely accepted the write. */
export type CommitPinOutcome = { ok: true; sha: string } | { ok: false; error: string };

export type DeploymentRollbackResult =
  { ok: true; sha: string; deploymentUuid: string } | { ok: false; error: string };

export async function executeDeploymentRollback(input: {
  appUuid: string;
  target: DeploymentRollbackTarget;
  pinCommit: (appUuid: string, sha: string) => Promise<CommitPinOutcome>;
  startDeploy: (appUuid: string) => Promise<{ deploymentUuid: string | null }>;
}): Promise<DeploymentRollbackResult> {
  let pinned: CommitPinOutcome;
  try {
    pinned = await input.pinCommit(input.appUuid, input.target.sha);
  } catch (error) {
    return {
      ok: false,
      error: `Coolify could not be reached to select ${rollbackCommitMessage(input.target)} (${error instanceof Error ? error.message : String(error)}). Nothing was deployed.`,
    };
  }
  if (!pinned.ok) {
    return { ok: false, error: `${pinned.error} Nothing was deployed.` };
  }

  let triggered: { deploymentUuid: string | null };
  try {
    triggered = await input.startDeploy(input.appUuid);
  } catch (error) {
    // The pin survives a failed deploy request, and saying so is the difference
    // between "press it again" and an operator hunting for why Coolify is
    // building an old commit.
    return {
      ok: false,
      error: `Coolify is pinned to ${input.target.shortSha} but the deploy request failed (${error instanceof Error ? error.message : String(error)}). Deploy the application from Coolify to finish the rollback.`,
    };
  }
  if (!triggered.deploymentUuid) {
    return {
      ok: false,
      error: `Coolify is pinned to ${input.target.shortSha} but did not return a deployment id, so this rollback could not be verified. Open the build log in Coolify to check it.`,
    };
  }
  return { ok: true, sha: input.target.sha, deploymentUuid: triggered.deploymentUuid };
}
