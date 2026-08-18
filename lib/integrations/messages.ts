import type { IntegrationKind, IntegrationStatus, IntegrationRow } from './types';
import { KIND_LABELS, PUBLISH_INTEGRATION_KINDS } from './types';

export function statusLabel(status: IntegrationStatus | string) {
  if (status === 'CONNECTED') return 'Connected';
  if (status === 'PENDING') return 'Incomplete';
  if (status === 'ERROR') return 'Error';
  return 'Not connected';
}

export function missingIntegrationKinds(rows: IntegrationRow[]): IntegrationKind[] {
  const connected = new Set(
    rows.filter((row) => row.status === 'CONNECTED').map((row) => row.kind),
  );
  return PUBLISH_INTEGRATION_KINDS.filter((kind) => !connected.has(kind));
}

function joinHindi(names: string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function publishBlockedMessage(
  missing: IntegrationKind[],
  isAdmin: boolean,
): string | null {
  if (missing.length === 0) return null;
  if (!isAdmin) return 'Ask an admin to finish setup';
  const names = missing.map((kind) => KIND_LABELS[kind]);
  const joined = joinHindi(names);
  return missing.length === 1 ? `${joined} is not connected` : `${joined} are not connected`;
}

export function disconnectWarning(liveCount: number): string | null {
  if (liveCount <= 0) return null;
  return `${liveCount} live sites are using this connection`;
}
