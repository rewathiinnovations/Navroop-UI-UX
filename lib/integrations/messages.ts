import type { IntegrationKind, IntegrationStatus, IntegrationRow } from './types';
import { KIND_LABELS, PUBLISH_INTEGRATION_KINDS } from './types';
import { SECRETS_UNREADABLE_MESSAGE } from './secrets';

export function statusLabel(status: IntegrationStatus | string) {
  if (status === 'CONNECTED') return 'Connected';
  if (status === 'PENDING') return 'Incomplete';
  if (status === 'ERROR') return 'Error';
  return 'Not connected';
}

/**
 * A publish integration counts as present only when it is CONNECTED *and* its stored
 * credentials can be read. A row whose blob will not decrypt used to pass this gate on the
 * strength of its status column alone, and publish then failed mid-flight (F-212).
 */
export function missingIntegrationKinds(rows: IntegrationRow[]): IntegrationKind[] {
  const usable = new Set(
    rows
      .filter((row) => row.status === 'CONNECTED' && !row.secretsUnreadable)
      .map((row) => row.kind),
  );
  return PUBLISH_INTEGRATION_KINDS.filter((kind) => !usable.has(kind));
}

function joinHindi(names: string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * `unreadable` names the kinds that are blocked because their credentials cannot be
 * decrypted. Those get the key-mismatch message: telling an admin that an integration they
 * can see is connected "is not connected" is advice that cannot be acted on.
 */
export function publishBlockedMessage(
  missing: IntegrationKind[],
  isAdmin: boolean,
  unreadable: IntegrationKind[] = [],
): string | null {
  if (missing.length === 0) return null;
  if (!isAdmin) return 'Ask an admin to finish setup';
  const unreadableNames = unreadable
    .filter((kind) => missing.includes(kind))
    .map((kind) => KIND_LABELS[kind]);
  const notConnected = missing
    .filter((kind) => !unreadable.includes(kind))
    .map((kind) => KIND_LABELS[kind]);
  const parts: string[] = [];
  if (notConnected.length > 0) {
    const joined = joinHindi(notConnected);
    parts.push(
      notConnected.length === 1 ? `${joined} is not connected` : `${joined} are not connected`,
    );
  }
  if (unreadableNames.length > 0) {
    parts.push(`${joinHindi(unreadableNames)}: ${SECRETS_UNREADABLE_MESSAGE}`);
  }
  return parts.join('. ');
}

export function disconnectWarning(liveCount: number): string | null {
  if (liveCount <= 0) return null;
  return `${liveCount} live sites are using this connection`;
}
