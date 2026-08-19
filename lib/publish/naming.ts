import type { DeploymentKind } from '@/generated/prisma';

/**
 * Deterministic publish names. Create and lookup must use these helpers
 * so they cannot drift.
 *
 * Coolify app: `{kind}-{slug}` e.g. live-acme / preview-acme
 * GitHub repo: LIVE = `{slug}`, PREVIEW = `preview-{slug}`
 * DNS label:   LIVE = `{slug}`, PREVIEW = `preview-{slug}`
 *
 * These generate names; nothing here recognises them. `isManagedCoolifyName`,
 * `isManagedDnsName` and `isManagedRepoName` are gone: reaping by name shape is what
 * deleted operators' `www`, `api` and `mail` records, because a LIVE name is a bare slug
 * indistinguishable from a hand-made label. Cleanup reaps by recorded provenance instead
 * (Deployment rows and PUBLISH `resourceIds`), so no classifier is left here for someone
 * to wire back into a delete path.
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

export function publishIdempotencyKey(projectId: string, kind: string, attempt = 'active') {
  return `publish:${projectId}:${kind}:${attempt}`;
}
