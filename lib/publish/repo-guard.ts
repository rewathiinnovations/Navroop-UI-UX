import { prisma } from '@/lib/db';

/**
 * F-202: publish must never force-push over an organisation repository this project did
 * not create. `ensureDeployRepo` finds-or-creates by name, and a name is not ownership —
 * a project called "Acme" must not replace a hand-made `deploy-org/acme`.
 *
 * Ownership is the repository's immutable id (`databaseId`), recorded on
 * `Deployment.githubRepoId` the moment this system creates the repo and compared on every
 * later publish. The column is read and written with raw SQL on purpose: the generated
 * Prisma client on a developer machine may predate the migration (regeneration is owned
 * by the dev-server agent), and raw SQL keeps the guard live either way.
 */

/** What the ensure call learned about the publish target. */
export type EnsuredRepo = {
  fullName: string;
  /** GitHub's immutable numeric repository id, as a string. */
  repoId: string;
  /** True when the ensure call created the repo in this request — ours by construction. */
  created: boolean;
};

export type RepoGuardInput = {
  repo: EnsuredRepo;
  /** `Deployment.githubRepoId` — null for first publishes and pre-feature rows. */
  recordedRepoId: string | null;
  /** `Deployment.repoFullName` — the repo a previous publish of this project targeted. */
  recordedRepoFullName: string | null;
  /**
   * Whether a previous publish of this deployment actually reached this repo:
   * `commitSha` (written right after a successful push) or `publishedAt` is set.
   */
  hasPushedBefore: boolean;
};

export type RepoGuardDecision =
  | { action: 'proceed' }
  | { action: 'adopt' }
  | { action: 'refuse'; reason: 'unowned' | 'mismatch' };

export function evaluateRepoGuard(input: RepoGuardInput): RepoGuardDecision {
  // A repo the ensure call just created cannot hold anyone else's work — even when a
  // recorded id points at a predecessor that has since vanished, the fresh repo wins.
  if (input.repo.created) return { action: 'proceed' };
  if (input.recordedRepoId) {
    return input.recordedRepoId === input.repo.repoId
      ? { action: 'proceed' }
      : // The name is ours on record, but the repo behind it was deleted and re-created
        // by someone else. Its contents are not this project's to replace.
        { action: 'refuse', reason: 'mismatch' };
  }
  // One-time backfill for repos created by earlier publishes of THIS project, before the
  // `githubRepoId` column existed: the Deployment row already points at exactly this repo
  // and a previous publish pushed to it (`commitSha`) or went live (`publishedAt`).
  // Adopt the id now instead of refusing, so pre-feature deployments keep re-publishing.
  if (input.recordedRepoFullName === input.repo.fullName && input.hasPushedBefore) {
    return { action: 'adopt' };
  }
  return { action: 'refuse', reason: 'unowned' };
}

export function repoConflictMessage(repoFullName: string) {
  const name = repoFullName.split('/').pop() || repoFullName;
  return (
    `The repository "${repoFullName}" already exists and was not created by this project, ` +
    `so publishing stopped before overwriting it. To replace its contents anyway, choose ` +
    `"Replace existing repository" in the Publish panel and type "${name}" to confirm — ` +
    `or rename the project to publish under a different name.`
  );
}

/** Thrown by the publish `github` step; mapped to the `repo_conflict` job error code. */
export class PublishRepoConflictError extends Error {
  readonly repoFullName: string;

  constructor(repoFullName: string) {
    super(repoConflictMessage(repoFullName));
    this.name = 'PublishRepoConflictError';
    this.repoFullName = repoFullName;
  }
}

/** Raw SQL: see the module comment — must work before the Prisma client is regenerated. */
export async function readDeploymentGithubRepoId(deploymentId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ githubRepoId: string | null }>>`
    SELECT "githubRepoId" FROM "Deployment" WHERE id = ${deploymentId}
  `;
  const value = rows[0]?.githubRepoId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Records which repo this deployment owns — id and name together, before any push. */
export async function recordDeploymentGithubRepo(
  deploymentId: string,
  repo: { repoId: string; fullName: string },
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Deployment"
    SET "githubRepoId" = ${repo.repoId}, "repoFullName" = ${repo.fullName}, "updatedAt" = NOW()
    WHERE id = ${deploymentId}
  `;
}
