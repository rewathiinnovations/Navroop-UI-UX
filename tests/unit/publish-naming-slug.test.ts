import { describe, expect, it } from 'vitest';
import {
  coolifyAppName,
  deployRepoName,
  dnsLabel,
  publishIdempotencyKey,
} from '@/lib/publish/naming';
import { isReservedSlug, slugCandidate, slugFromName } from '@/lib/publish/slug';

/**
 * Publish names are how creation stays deterministic: a re-publish has to land on the
 * same Coolify app, repo and host rather than growing a second set.
 *
 * Recognition is deliberately not tested here because it no longer exists. The name
 * classifiers were deleted with the name-shape orphan reaper — a bare LIVE slug is
 * indistinguishable from `www`, and matching on it deleted operators' own DNS records.
 * Cleanup reads recorded provenance (Deployment rows and PUBLISH `resourceIds`), which
 * `tests/unit/orphan-cleanup-provenance.test.ts` covers.
 */
describe('publish naming', () => {
  it('derives the app, repo and DNS names per kind', () => {
    expect(coolifyAppName('acme', 'LIVE')).toBe('live-acme');
    expect(coolifyAppName('acme', 'PREVIEW')).toBe('preview-acme');
    // A live repo and host keep the bare slug; only previews get a prefix.
    expect(deployRepoName('acme', 'LIVE')).toBe('acme');
    expect(deployRepoName('acme', 'PREVIEW')).toBe('preview-acme');
    expect(dnsLabel('acme', 'LIVE')).toBe('acme');
    expect(dnsLabel('acme', 'PREVIEW')).toBe('preview-acme');
  });

  it('keys publish idempotency by project, kind and attempt', () => {
    expect(publishIdempotencyKey('p1', 'LIVE')).toBe('publish:p1:LIVE:active');
    expect(publishIdempotencyKey('p1', 'LIVE', '2')).toBe('publish:p1:LIVE:2');
  });
});

describe('publish slugs', () => {
  it('reduces a project name to a hostname-safe slug', () => {
    expect(slugFromName('  Ember & Oak Coffee  ')).toBe('ember-oak-coffee');
    expect(slugFromName('!!!')).toBe('site');
    expect(slugFromName('a'.repeat(60))).toHaveLength(40);
  });

  it('treats preview- as reserved so a slug cannot impersonate a preview host', () => {
    expect(isReservedSlug('preview-acme')).toBe(true);
    expect(isReservedSlug('acme')).toBe(false);
  });

  it('bumps a reserved first candidate rather than claiming it', () => {
    expect(slugCandidate('preview-acme', 1)).toBe('preview-acme-site');
  });

  it('appends the attempt on collisions and stays inside the length limit', () => {
    expect(slugCandidate('acme', 2)).toBe('acme-2');
    expect(slugCandidate('a'.repeat(60), 12)).toHaveLength(40);
    expect(slugCandidate('a'.repeat(60), 12).endsWith('-12')).toBe(true);
  });
});
