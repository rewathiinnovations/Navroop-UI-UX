import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import type { GithubWebhookEffect } from './github-webhook';
import { upsertIntegration } from './store';

/**
 * Applies the effects `interpretGithubWebhook` derived from a *verified* delivery (F-265).
 *
 * Every write here is a record of something GitHub told us, surfaced where an operator
 * already looks: `Integration.lastError` on /admin/integrations and /admin/health,
 * `Deployment.lastError` in the project's Publish panel. Nothing here changes a
 * `Deployment.status` — a deploy repo going away does not take the live site down, and
 * saying otherwise would be a guess dressed as a fact.
 */

export const GITHUB_WEBHOOK_COPY = {
  suspended:
    'GitHub suspended this App installation, so publishing cannot reach GitHub. Unsuspend the Navroop Deploy app on GitHub, then reconnect here.',
  removed:
    'This GitHub App installation was removed on GitHub, so publishing cannot reach GitHub. Install the app again from this page.',
} as const;

export function repoUnreachableMessage(
  repoFullName: string | null,
  because: 'deleted' | 'renamed' | 'transferred' | 'archived' | 'access-removed',
) {
  const repo = repoFullName ?? 'the deploy repository';
  const cause: Record<typeof because, string> = {
    deleted: `${repo} was deleted on GitHub`,
    renamed: `${repo} was renamed on GitHub`,
    transferred: `${repo} was transferred to another owner on GitHub`,
    archived: `${repo} was archived on GitHub`,
    'access-removed': `the GitHub App lost access to ${repo}`,
  };
  return `${cause[because]}. The live site is untouched, but the next publish will fail until you publish again to recreate the repository.`;
}

export function foreignPushMessage(input: {
  repoFullName: string | null;
  ref: string;
  pusher: string;
}) {
  const repo = input.repoFullName ?? 'the deploy repository';
  return `${input.pusher} pushed to ${input.ref} in ${repo}, which Navroop did not do. The deployed site may not match this project until you publish again.`;
}

/**
 * The `githubRepoId` column is read with raw SQL for the same reason
 * `lib/publish/repo-guard.ts` does: the generated Prisma client on a machine that has not
 * re-run `prisma generate` predates it, and the reaction has to work either way.
 */
async function noteOnDeploymentsForRepo(repoId: string, message: string) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Deployment" WHERE "githubRepoId" = ${repoId}
  `;
  for (const row of rows) {
    await prisma.deployment.update({ where: { id: row.id }, data: { lastError: message } });
  }
  return rows.length;
}

export type GithubWebhookOutcome = {
  /** Effects that changed a row. */
  applied: number;
  /** Effects that matched nothing to record against — an unknown repo, mostly. */
  skipped: number;
};

export async function applyGithubWebhookEffects(
  effects: GithubWebhookEffect[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<GithubWebhookOutcome> {
  let applied = 0;
  let skipped = 0;

  for (const effect of effects) {
    if (effect.kind === 'ignored') {
      skipped += 1;
      continue;
    }

    if (effect.kind === 'installation-suspended') {
      await upsertIntegration({
        workspaceId,
        kind: 'GITHUB_DEPLOY',
        status: 'ERROR',
        lastError: GITHUB_WEBHOOK_COPY.suspended,
      });
      applied += 1;
      continue;
    }

    if (effect.kind === 'installation-removed') {
      // The installation id and account no longer name anything, so they are cleared
      // rather than left pointing at an installation GitHub has deleted.
      await upsertIntegration({
        workspaceId,
        kind: 'GITHUB_DEPLOY',
        status: 'ERROR',
        config: { installationId: undefined, accountLogin: undefined },
        lastError: GITHUB_WEBHOOK_COPY.removed,
      });
      applied += 1;
      continue;
    }

    if (effect.kind === 'installation-restored') {
      // Only undoes what a suspension did. An unsuspend does not promote a row that was
      // never finished connecting, and it does not clear an unrelated error.
      const row = await prisma.integration.findUnique({
        where: { workspaceId_kind: { workspaceId, kind: 'GITHUB_DEPLOY' } },
        select: { status: true, lastError: true },
      });
      if (row?.status === 'ERROR' && row.lastError === GITHUB_WEBHOOK_COPY.suspended) {
        await prisma.integration.update({
          where: { workspaceId_kind: { workspaceId, kind: 'GITHUB_DEPLOY' } },
          data: { status: 'CONNECTED', lastError: null },
        });
        applied += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const message =
      effect.kind === 'repo-unreachable'
        ? repoUnreachableMessage(effect.repoFullName, effect.because)
        : foreignPushMessage(effect);
    const touched = await noteOnDeploymentsForRepo(effect.repoId, message);
    if (touched) {
      applied += touched;
      log.warn('integrations.github_webhook_deployment_note', {
        kind: effect.kind,
        repoId: effect.repoId,
        deployments: touched,
      });
    } else {
      // A repo this instance never published to. Common: the App is installed on an
      // account with other repositories.
      skipped += 1;
    }
  }

  return { applied, skipped };
}
