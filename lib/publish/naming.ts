import type { DeploymentKind } from '@/generated/prisma';

/**
 * Deterministic publish names. Create and lookup must use these helpers
 * so they cannot drift.
 *
 * Coolify app: `{kind}-{slug}` e.g. live-acme / preview-acme
 * GitHub repo: LIVE = `{slug}`, PREVIEW = `preview-{slug}`
 * DNS label:   LIVE = `{slug}`, PREVIEW = `preview-{slug}`
 */
export function coolifyAppName(slug: string, kind: DeploymentKind | 'LIVE' | 'PREVIEW') {
  return `${String(kind).toLowerCase()}-${slug}`;
}

export function deployRepoName(slug: string, kind: DeploymentKind | 'LIVE' | 'PREVIEW') {
  return kind === 'PREVIEW' ? `preview-${slug}` : slug;
}

export function dnsLabel(slug: string, kind: DeploymentKind | 'LIVE' | 'PREVIEW') {
  return kind === 'PREVIEW' ? `preview-${slug}` : slug;
}

export function isManagedCoolifyName(name: string) {
  return /^(live|preview)-[a-z0-9-]+$/i.test(name.trim());
}

export function isManagedDnsName(name: string, root: string) {
  const host = name.replace(/\.$/, '').toLowerCase();
  const zone = root.replace(/\.$/, '').toLowerCase();
  if (!zone || !host.endsWith(`.${zone}`)) return false;
  const label = host.slice(0, -zone.length - 1);
  return /^((preview-)?[a-z0-9-]+)$/.test(label);
}

export function isManagedRepoName(name: string) {
  const short = name.includes('/') ? name.split('/').pop() || '' : name;
  return /^((preview-)?[a-z0-9-]+)$/.test(short);
}

export function publishIdempotencyKey(projectId: string, kind: string, attempt = 'active') {
  return `publish:${projectId}:${kind}:${attempt}`;
}
