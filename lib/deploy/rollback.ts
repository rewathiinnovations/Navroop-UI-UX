import { previousRelease, type ReleaseRecord } from './release';

export const ROLLBACK_CONFIRM_PHRASE = 'roll back';

export type RollbackRequest = {
  currentSha: string;
  targetSha?: string;
  confirmation: string;
  history: ReleaseRecord[];
};

export type RollbackPlan =
  { ok: true; target: ReleaseRecord; currentSha: string } | { ok: false; error: string };

export function planRollback(input: RollbackRequest): RollbackPlan {
  if (input.confirmation.trim().toLowerCase() !== ROLLBACK_CONFIRM_PHRASE) {
    return { ok: false, error: `Type "${ROLLBACK_CONFIRM_PHRASE}" to confirm` };
  }
  const target = input.targetSha
    ? (input.history.find((row) => row.sha === input.targetSha) ?? null)
    : previousRelease(input.history, input.currentSha);
  if (!target) {
    return { ok: false, error: 'No previous release is available' };
  }
  if (target.sha === input.currentSha) {
    return { ok: false, error: 'Already on this release' };
  }
  return { ok: true, target, currentSha: input.currentSha };
}

export function coolifyApplicationPath(applicationUuid: string) {
  return `/api/v1/applications/${encodeURIComponent(applicationUuid)}`;
}

export function coolifyRedeployPath(applicationUuid: string) {
  return `/api/v1/deploy?uuid=${encodeURIComponent(applicationUuid)}&force=true`;
}

export type CoolifyRollbackResult =
  { ok: true; sha: string; deploymentUuid: string | null } | { ok: false; error: string };

function deploymentUuidFrom(payload: unknown): string | null {
  const row =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const queued = Array.isArray(row.deployments) ? row.deployments[0] : null;
  const first = queued && typeof queued === 'object' ? (queued as Record<string, unknown>) : row;
  const uuid = first.deployment_uuid ?? first.uuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
}

function commitShaFrom(payload: unknown): string | null {
  const row =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const nested =
    row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
  const sha = row.git_commit_sha ?? nested.git_commit_sha;
  return typeof sha === 'string' && sha ? sha : null;
}

/**
 * Roll the application back by pinning it to a previous commit and deploying that.
 *
 * `/api/v1/deploy` is Coolify's *redeploy the current configuration* endpoint: it has no
 * parameter naming a release, and the release used to be passed as an invented
 * `X-Navroop-Image-Tag` header Coolify has no code to read. So the old implementation
 * redeployed the broken release and reported success.
 *
 * The parameter that does select a release is the application's `git_commit_sha`
 * (`PATCH /api/v1/applications/{uuid}`); Coolify resolves a deploy to it when the request
 * names no commit. Because that is a *configuration* write, the order matters: pin, read
 * the pin back, and only deploy once it is proven. Every failure before that point returns
 * `ok: false` having deployed nothing — a rollback that quietly redeploys the release it
 * was asked to replace is worse than one that refuses.
 *
 * The application stays pinned to `targetSha` afterwards. Rolling forward again means
 * setting `git_commit_sha` back to `HEAD` (or the wanted commit) — the caller's copy has
 * to say so, because a later "deploy latest" from Coolify will otherwise rebuild this
 * same commit.
 */
export async function executeCoolifyRollback(input: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  applicationUuid: string;
  targetSha: string;
}): Promise<CoolifyRollbackResult> {
  const applicationPath = coolifyApplicationPath(input.applicationUuid);

  const pinned = await input.request(applicationPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ git_commit_sha: input.targetSha }),
  });
  if (!pinned.ok) {
    return {
      ok: false,
      error: `Coolify refused to pin this application to a previous commit (${pinned.status}). Nothing was deployed.`,
    };
  }

  const readBack = await input.request(applicationPath, { method: 'GET' });
  if (!readBack.ok) {
    return {
      ok: false,
      error: `Coolify could not confirm the pinned commit (${readBack.status}). Nothing was deployed.`,
    };
  }
  const actual = commitShaFrom(await readBack.json().catch(() => null));
  if (actual !== input.targetSha) {
    return {
      ok: false,
      error: `Coolify still reports commit ${actual ?? 'unknown'} for this application, so the rollback was not applied. Nothing was deployed.`,
    };
  }

  const deployed = await input.request(coolifyRedeployPath(input.applicationUuid), {
    method: 'GET',
  });
  if (!deployed.ok) {
    return {
      ok: false,
      error: `Coolify is pinned to ${input.targetSha} but the deploy request failed (${deployed.status}). Deploy the application from Coolify to finish the rollback.`,
    };
  }

  return {
    ok: true,
    sha: input.targetSha,
    deploymentUuid: deploymentUuidFrom(await deployed.json().catch(() => null)),
  };
}
