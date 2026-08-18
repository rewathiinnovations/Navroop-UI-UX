export type StickyProject = {
  sandboxId: string | null;
  sandboxStatus: string | null;
  sandboxProviderConfigId: string | null;
  strategyPickId: string | null;
};

const LIVE_STATUSES = new Set(['READY', 'BOOTING']);

/**
 * A sandbox created on one account can only be probed or killed through that
 * same account's credentials — store the config id, never infer from strategy.
 */
export function resolveStickyProvider(project: StickyProject) {
  const running = Boolean(project.sandboxId) && LIVE_STATUSES.has(project.sandboxStatus || '');
  if (running && project.sandboxProviderConfigId) {
    return project.sandboxProviderConfigId;
  }
  return project.strategyPickId;
}
