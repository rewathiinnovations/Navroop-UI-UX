export const DEPLOY_HISTORY_KEY = 'deploy.history';
export const DEPLOY_CURRENT_KEY = 'deploy.current';
export const MAX_RELEASE_HISTORY = 10;

export type ReleaseRecord = {
  sha: string;
  deployedAt: string;
};

export function currentRelease(env: NodeJS.ProcessEnv = process.env): ReleaseRecord {
  const sha =
    env.GIT_SHA ||
    env.SOURCE_COMMIT ||
    env.COOLIFY_CONTAINER_NAME ||
    'unknown';
  const deployedAt = env.DEPLOYED_AT || new Date(0).toISOString();
  return { sha: String(sha), deployedAt };
}

export function pushReleaseHistory(history: ReleaseRecord[], next: ReleaseRecord) {
  const without = history.filter((row) => row.sha !== next.sha);
  return [next, ...without].slice(0, MAX_RELEASE_HISTORY);
}

export function previousRelease(history: ReleaseRecord[], currentSha: string) {
  const idx = history.findIndex((row) => row.sha === currentSha);
  if (idx >= 0) return history[idx + 1] ?? null;
  return history[1] ?? null;
}

export function parseReleaseHistory(raw: string | null | undefined): ReleaseRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ReleaseRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && typeof row.sha === 'string' && typeof row.deployedAt === 'string');
  } catch {
    return [];
  }
}
