import { prisma } from '@/lib/db';
import type { DeploymentKind } from '@/generated/prisma';
import { log } from '@/lib/logger';
import { dnsLabel } from './naming';

export const RESERVED_SLUGS = new Set([
  'www',
  'app',
  'api',
  'admin',
  'preview',
  'mail',
  'docs',
  'blog',
  'status',
  'cdn',
  'static',
  'staging',
]);

export function slugFromName(name: string) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || 'site';
}

export function isReservedSlug(slug: string) {
  return RESERVED_SLUGS.has(slug) || slug.startsWith('preview-');
}

/**
 * LIVE slugs never change once assigned. Collisions append -2, -3.
 * Reserved labels are rejected and bumped.
 */
export async function resolveUniqueSlug(input: {
  name: string;
  kind: DeploymentKind;
  existingSlug?: string | null;
}) {
  if (input.kind === 'LIVE' && input.existingSlug) {
    return input.existingSlug;
  }
  if (input.existingSlug) return input.existingSlug;

  let candidate = slugFromName(input.name);
  if (isReservedSlug(candidate)) candidate = `${candidate}-site`.slice(0, 40);

  let n = 2;
  while (true) {
    const clash = await prisma.deployment.findFirst({
      where: { slug: candidate, kind: input.kind },
      select: { id: true },
    });
    if (!clash && !isReservedSlug(candidate)) return candidate;
    const suffix = `-${n}`;
    candidate = `${slugFromName(input.name).slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
    if (n > 99) throw new Error('No slug is available for this name');
  }
}

/** Same shape resolveUniqueSlug produces: base, then base-2, base-3, … */
export function slugCandidate(name: string, attempt: number) {
  const base = slugFromName(name);
  if (attempt <= 1) {
    return isReservedSlug(base) ? `${base}-site`.slice(0, 40) : base;
  }
  const suffix = `-${attempt}`;
  return `${base.slice(0, 40 - suffix.length)}${suffix}`;
}

/** Matches resolveUniqueSlug's old ceiling of n > 99. */
export const SLUG_CLAIM_MAX_ATTEMPTS = 99;

export const SLUG_UNAVAILABLE_MESSAGE =
  'No publish address is available for this project name. Rename the project and publish again.';

/**
 * A unique-constraint violation on the slug write.
 *
 * Two unique indexes can fire, and both mean "someone else took this name":
 * `Deployment_slug_kind_key` on (slug, kind), and the functional
 * `Deployment_dns_label_key`, which also catches LIVE `preview-acme` colliding with
 * PREVIEW `acme`. Prisma reports P2002; a raw statement reports Postgres 23505.
 */
export function isSlugTakenError(error: unknown) {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (code === 'P2002' || code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Deployment_slug_kind_key|Deployment_dns_label_key/i.test(message);
}

/**
 * Claim a slug by writing it, not by checking first.
 *
 * `resolveUniqueSlug` reads then returns, so two concurrent publishes of same-named
 * projects both get the same candidate and the loser used to surface a raw Prisma
 * unique-violation. Here the database is the arbiter: on a collision we bump the
 * suffix and write again, so the loser transparently lands on `name-2`.
 */
export async function claimSlug(input: {
  name: string;
  kind: DeploymentKind;
  existingSlug?: string | null;
  claim: (slug: string) => Promise<void>;
  maxAttempts?: number;
  isTaken?: (error: unknown) => boolean;
  onRetry?: (info: { candidate: string; attempt: number }) => void;
}): Promise<string> {
  if (input.existingSlug) return input.existingSlug;

  const taken = input.isTaken ?? isSlugTakenError;
  const maxAttempts = input.maxAttempts ?? SLUG_CLAIM_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = slugCandidate(input.name, attempt);
    if (isReservedSlug(candidate)) continue;
    try {
      await input.claim(candidate);
      return candidate;
    } catch (error) {
      if (!taken(error)) throw error;
      input.onRetry?.({ candidate, attempt });
      log.warn('publish.slug_taken_retrying', { candidate, attempt, kind: input.kind });
    }
  }

  throw new Error(SLUG_UNAVAILABLE_MESSAGE);
}

export function hostForSlug(slug: string, kind: DeploymentKind, root: string) {
  return `${dnsLabel(slug, kind)}.${root}`;
}

export function urlForSlug(slug: string, kind: DeploymentKind, root: string) {
  return `https://${hostForSlug(slug, kind, root)}`;
}

export { dnsLabel as dnsLabelForSlug, deployRepoName as repoNameForSlug } from './naming';
