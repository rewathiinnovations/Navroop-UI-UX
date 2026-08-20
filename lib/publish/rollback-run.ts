import { prisma } from '@/lib/db';
import {
  COOLIFY_STATUS_UNREPORTED,
  getCoolifyDeployment,
  pinApplicationCommit,
  triggerDeploy,
} from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { listDeployCommits } from '@/lib/github/deploy-client';
import { sleep } from '@/utils/sleep';
import { log } from '@/lib/logger';
import {
  DEFAULT_DEPLOY_BRANCH,
  PUBLISH_POLL_MS,
  PUBLISH_POLL_TIMEOUT_MS,
  PUBLISH_UNREPORTED_RETRY_MS,
  PUBLISH_UNREPORTED_STATUS_READS,
} from './constants';
import {
  deploymentReleases,
  executeDeploymentRollback,
  rollbackCommitMessage,
  type DeploymentRelease,
  type DeploymentRollbackTarget,
} from './rollback';

/**
 * Everything a rollback does outside the pure planner: read the release history,
 * talk to Coolify, and settle the `Deployment` row.
 *
 * Split out of `lib/publish/actions.ts` so the gated module stays authorization +
 * plan + call, and out of `./rollback.ts` so the planner keeps no database import
 * and stays unit-testable without a Prisma mock.
 */

/** How many past publishes the rollback picker offers. One commit = one publish. */
export const RELEASE_HISTORY_LIMIT = 20;

export type ReleaseHistory =
  { ok: true; releases: DeploymentRelease[] } | { ok: false; error: string };

export async function readReleaseHistory(deployment: {
  workspaceId: string;
  repoFullName: string | null;
  repoBranch: string;
  commitSha: string | null;
}): Promise<ReleaseHistory> {
  if (!deployment.repoFullName) return { ok: true, releases: [] };
  try {
    const commits = await listDeployCommits(
      deployment.repoFullName,
      deployment.repoBranch || DEFAULT_DEPLOY_BRANCH,
      RELEASE_HISTORY_LIMIT,
      deployment.workspaceId,
    );
    return { ok: true, releases: deploymentReleases(commits, deployment.commitSha) };
  } catch (error) {
    // Never an empty list: "GitHub would not answer" and "this site has only ever
    // been published once" are different facts, and rendering the first as the
    // second is a rollback button that silently has nothing to offer.
    return {
      ok: false,
      error: `Could not read this site\u2019s release history from GitHub (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

export type StartedRollback =
  | { ok: true; sha: string; deploymentUuid: string; buildLogUrl: string }
  | { ok: false; error: string; status: 409 | 502 };

/**
 * Pin, prove, deploy, and mark the row BUILDING — the part that must finish inside
 * the request so its refusals reach the user. The build itself is watched by
 * `settleRollback`.
 */
export async function startRollback(input: {
  deployment: { id: string; serverId: string; coolifyAppUuid: string };
  target: DeploymentRollbackTarget;
}): Promise<StartedRollback> {
  const server = await prisma.coolifyServer.findUnique({
    where: { id: input.deployment.serverId },
  });
  if (!server) {
    return {
      ok: false,
      error:
        'The Coolify server this site was published to is no longer configured, so it cannot be rolled back.',
      status: 409,
    };
  }
  const auth = serverAuth(server);
  const result = await executeDeploymentRollback({
    appUuid: input.deployment.coolifyAppUuid,
    target: input.target,
    pinCommit: (appUuid, sha) => pinApplicationCommit(auth, appUuid, sha),
    startDeploy: (appUuid) => triggerDeploy(auth, appUuid),
  });
  if (!result.ok) return { ok: false, error: result.error, status: 502 };

  const buildLogUrl = `${server.apiUrl.replace(/\/+$/, '')}/application/${input.deployment.coolifyAppUuid}`;
  // `commitSha` moves now, not after the build: Coolify is already pinned to this
  // release, so it is the release the next deploy ships whatever this build does.
  // Leaving the old sha on the row would make the release list offer the target
  // again as if nothing had happened.
  await prisma.deployment.update({
    where: { id: input.deployment.id },
    data: {
      status: 'BUILDING',
      commitSha: result.sha,
      progressStep: 'rollback',
      lastError: null,
      lastRequestId: result.deploymentUuid,
      buildLogUrl,
    },
  });
  return { ok: true, sha: result.sha, deploymentUuid: result.deploymentUuid, buildLogUrl };
}

/**
 * Watches the rollback build to a verdict and writes it to the row.
 *
 * Runs in `after()`, so nothing is waiting on it — which is exactly why it must
 * always leave the row in a settled state. A rollback that left BUILDING forever
 * is the silent-stuck shape this engagement exists to remove, so every exit
 * (timeout, unreported status, a thrown Coolify error) writes FAILED with a
 * sentence naming what was not verified. The site is genuinely serving the pinned
 * release either way; what is unknown is whether the build of it succeeded.
 */
export async function settleRollback(input: {
  deploymentId: string;
  serverId: string;
  coolifyDeploymentUuid: string;
  target: DeploymentRollbackTarget;
}) {
  const server = await prisma.coolifyServer.findUnique({ where: { id: input.serverId } });
  if (!server) {
    await prisma.deployment.update({
      where: { id: input.deploymentId },
      data: {
        status: 'FAILED',
        progressStep: null,
        lastError:
          'The Coolify server was removed while the rollback was building, so the build could not be verified.',
      },
    });
    return;
  }
  const auth = serverAuth(server);
  const deadline = Date.now() + PUBLISH_POLL_TIMEOUT_MS;
  let unreported = 0;
  let outcome: { status: 'LIVE' } | { status: 'FAILED'; error: string } = {
    status: 'FAILED',
    error: `Coolify did not report a result for the rollback to ${rollbackCommitMessage(input.target)} within the time allowed. Open the build log to see what it did.`,
  };
  try {
    while (Date.now() < deadline) {
      const state = await getCoolifyDeployment(auth, input.coolifyDeploymentUuid);
      if (state.status === COOLIFY_STATUS_UNREPORTED) {
        unreported += 1;
        if (unreported >= PUBLISH_UNREPORTED_STATUS_READS) {
          outcome = {
            status: 'FAILED',
            error: `Coolify did not report a status for the rollback build after ${unreported} checks. Open the build log to see what it did.`,
          };
          break;
        }
        await sleep(PUBLISH_UNREPORTED_RETRY_MS);
        continue;
      }
      unreported = 0;
      if (state.health === 'healthy') {
        outcome = { status: 'LIVE' };
        break;
      }
      if (state.health === 'failed') {
        outcome = {
          status: 'FAILED',
          error: `Coolify reported "${state.status}" for the rollback build. The site is pinned to ${input.target.shortSha}; open the build log to see why it would not build.`,
        };
        break;
      }
      await sleep(PUBLISH_POLL_MS);
    }
  } catch (error) {
    outcome = {
      status: 'FAILED',
      error: `The rollback build could not be checked (${error instanceof Error ? error.message : String(error)}). The site is pinned to ${input.target.shortSha}; open the build log in Coolify.`,
    };
  }

  await prisma.deployment
    .update({
      where: { id: input.deploymentId },
      data:
        outcome.status === 'LIVE'
          ? { status: 'LIVE', progressStep: null, lastError: null, publishedAt: new Date() }
          : { status: 'FAILED', progressStep: null, lastError: outcome.error },
    })
    .catch((error) => {
      log.error('publish.rollback_settle_failed', {
        deploymentId: input.deploymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
