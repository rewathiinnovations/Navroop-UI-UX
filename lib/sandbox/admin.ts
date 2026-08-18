import { LAST_ACTIVE_DEACTIVATE_WARNING } from './provider';

export function lastActiveDeactivateWarning(activeCount: number) {
  if (activeCount <= 1) return LAST_ACTIVE_DEACTIVATE_WARNING;
  return null;
}
