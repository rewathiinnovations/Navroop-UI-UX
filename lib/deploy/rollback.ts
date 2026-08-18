import { previousRelease, type ReleaseRecord } from './release';

export const ROLLBACK_CONFIRM_PHRASE = 'roll back';

export type RollbackRequest = {
  currentSha: string;
  targetSha?: string;
  confirmation: string;
  history: ReleaseRecord[];
};

export type RollbackPlan =
  | { ok: true; target: ReleaseRecord; currentSha: string }
  | { ok: false; error: string };

export function planRollback(input: RollbackRequest): RollbackPlan {
  if (input.confirmation.trim().toLowerCase() !== ROLLBACK_CONFIRM_PHRASE) {
    return { ok: false, error: `Type "${ROLLBACK_CONFIRM_PHRASE}" to confirm` };
  }
  const target = input.targetSha
    ? input.history.find((row) => row.sha === input.targetSha) ?? null
    : previousRelease(input.history, input.currentSha);
  if (!target) {
    return { ok: false, error: 'No previous release is available' };
  }
  if (target.sha === input.currentSha) {
    return { ok: false, error: 'Already on this release' };
  }
  return { ok: true, target, currentSha: input.currentSha };
}

export function coolifyRedeployPath(applicationUuid: string) {
  return `/api/v1/deploy?uuid=${encodeURIComponent(applicationUuid)}&force=true`;
}

export async function executeCoolifyRollback(input: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  applicationUuid: string;
  imageTag: string;
}) {
  const path = coolifyRedeployPath(input.applicationUuid);
  const response = await input.request(path, {
    method: 'GET',
    headers: { 'X-Navroop-Image-Tag': input.imageTag },
  });
  if (!response.ok) {
    return { ok: false as const, error: `Coolify rollback returned ${response.status}` };
  }
  return { ok: true as const };
}
