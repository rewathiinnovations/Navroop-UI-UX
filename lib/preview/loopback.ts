/**
 * Whether a hostname can only ever reach this machine.
 *
 * `.localhost` names are loopback by definition (RFC 6761 §6.3) and every
 * current browser resolves them to the loopback interface and treats them as
 * secure contexts — which is what lets local development have the same
 * *sibling-origin* preview isolation production gets from `preview-static.{zone}`
 * without owning a TLS certificate: `preview-static.localhost:3000` is a
 * different origin from `localhost:3000`, so host-only session cookies are not
 * sent to it and its storage is its own (F-140), while both names land on the
 * same dev server.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
  );
}

/** Convenience over a full origin/URL string; false when it does not parse. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}
