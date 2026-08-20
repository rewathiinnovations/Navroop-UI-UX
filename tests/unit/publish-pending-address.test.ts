import { describe, expect, it } from 'vitest';
import { isPlaceholderSlug } from '@/lib/publish/naming';
import { serializeDeployment } from '@/lib/publish/serialize';
import type { Deployment } from '@/generated/prisma';

/**
 * What address the product is allowed to show before a slug has been claimed.
 *
 * `startPublishJob` seeds a new Deployment with `pending-<8 hex>` and the `slug` step
 * replaces it with the real one. While the placeholder is in place, both the publish
 * sheet and `/deployments` used to substitute the literal string `site` — rendering
 * `https://site.<zone>` as a confident URL. `slugFromName` returns `site` for any name
 * that slugifies to nothing, so that host can be a real, claimed slug belonging to
 * another project: "we do not know the address yet" was being displayed as a specific
 * wrong address, occasionally somebody else's live site (F-244).
 *
 * Goes red if a placeholder slug is ever rendered as a host again, or if the
 * placeholder test starts matching a genuine slug that happens to begin with
 * `pending-` (a project called "Pending Order App" slugifies to exactly that).
 */

const ZONE = 'navroop.test';

function deploymentRow(slug: string): Deployment {
  return {
    id: 'dep_1',
    projectId: 'proj_1',
    workspaceId: 'default',
    serverId: 'srv_1',
    kind: 'LIVE',
    status: 'QUEUED',
    slug,
    url: null,
    repoFullName: null,
    repoBranch: null,
    githubRepoId: null,
    commitSha: null,
    coolifyAppUuid: null,
    dnsRecordId: null,
    buildLogUrl: null,
    passwordHash: null,
    progressStep: null,
    lastError: null,
    lastRequestId: null,
    publishedAt: null,
    publishedById: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  } as unknown as Deployment;
}

describe('isPlaceholderSlug', () => {
  it('recognises the seeded placeholder and nothing else', () => {
    expect(isPlaceholderSlug('pending-a1b2c3d4')).toBe(true);
    // A project name can slugify to something that starts with the same word. Reading
    // that as "no address yet" is what hid a real, claimed slug behind `site`.
    expect(isPlaceholderSlug('pending-order-app')).toBe(false);
    expect(isPlaceholderSlug('pending')).toBe(false);
    expect(isPlaceholderSlug('acme')).toBe(false);
  });
});

describe('serializeDeployment expectedUrl', () => {
  it('says nothing at all while the slug is a placeholder', () => {
    const serialized = serializeDeployment(deploymentRow('pending-a1b2c3d4'), ZONE);

    expect(serialized.expectedUrl).toBe('');
    expect(serialized.canonicalUrl).toBe('');
    // The old behaviour: `https://site.navroop.test`, a host that can belong to
    // another project.
    expect(serialized.expectedUrl).not.toContain('site.');
  });

  it('shows the real address once the slug is claimed', () => {
    const serialized = serializeDeployment(deploymentRow('acme'), ZONE);

    expect(serialized.expectedUrl).toBe(`https://acme.${ZONE}`);
  });

  it('keeps a genuine slug that merely starts with the placeholder word', () => {
    const serialized = serializeDeployment(deploymentRow('pending-order-app'), ZONE);

    expect(serialized.expectedUrl).toBe(`https://pending-order-app.${ZONE}`);
  });
});
