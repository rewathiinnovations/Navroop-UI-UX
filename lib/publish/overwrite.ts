import type { DeploymentKind } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { deployOrg, getDeployRepo } from '@/lib/github/deploy-client';
import { log } from '@/lib/logger';
import { deployRepoName } from './naming';
import { recordDeploymentGithubRepo } from './repo-guard';

export type OverwriteConfirmResult =
  { ok: true } | { ok: false; error: string; status: 404 | 409 | 422 };

/**
 * The F-202 escape hatch: the publish guard refused because the target repository was
 * not created by this project, and the user explicitly chose to replace it by typing the
 * repository name.
 *
 * Server-side re-validation on purpose — the client's `overwrite: true` alone proves
 * nothing. Only when the typed name equals the deploy repo name derived from this
 * deployment's claimed slug is the existing repo's immutable id adopted onto the row,
 * which is what makes the next run of the guard proceed.
 */
export async function confirmRepoOverwrite(input: {
  projectId: string;
  kind: DeploymentKind;
  confirmName: string;
  userId: string;
}): Promise<OverwriteConfirmResult> {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
  });
  if (!deployment || deployment.slug.startsWith('pending-')) {
    // No claimed slug means no repo name to collide on — the refusal this hatch answers
    // cannot have happened yet.
    return {
      ok: false,
      error: 'There is no repository to replace yet — publish normally first.',
      status: 404,
    };
  }
  const expected = deployRepoName(deployment.slug, input.kind);
  if (input.confirmName.trim() !== expected) {
    return {
      ok: false,
      error: `Type the repository name "${expected}" exactly to confirm the replacement.`,
      status: 422,
    };
  }
  const org = await deployOrg(deployment.workspaceId);
  const existing = await getDeployRepo(`${org}/${expected}`, deployment.workspaceId);
  if (existing) {
    // Adoption is the entire effect: record the existing repo's immutable id so the
    // publish guard treats it as this project's repo and the push proceeds.
    await recordDeploymentGithubRepo(deployment.id, existing);
    log.info('publish.repo_overwrite_confirmed', {
      projectId: input.projectId,
      kind: input.kind,
      repo: existing.fullName,
      userId: input.userId,
    });
  }
  // 404: the colliding repo is gone; nothing to overwrite — publish will create it fresh.
  return { ok: true };
}
