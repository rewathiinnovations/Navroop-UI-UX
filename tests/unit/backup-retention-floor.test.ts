import { describe, expect, it } from 'vitest';
import { RETENTION_KEEP_NEWEST, retentionDecisions } from '@/lib/backup/retention';

/**
 * F-702: retention keeps an object only when its `lastModified` clears a cutoff computed from
 * `now`. On a host whose clock has jumped forward, every object misses every cutoff and one
 * pass deletes the whole backup history — including the dump the run just wrote.
 *
 * The floor: the newest N objects, ordered by their *recorded* timestamps (never clock
 * arithmetic), survive regardless of age; and the caller can name keys — the run's own
 * just-written dump — that must survive even when the bucket reports them with a wrong,
 * ancient timestamp.
 *
 * Goes red if: a skewed clock can empty the bucket again; the just-written key becomes
 * deletable; or keep/delete stop being an exact partition of the listing.
 */

function ancient(daysAgo: number) {
  // All relative to a fixed epoch far in the past, so every object misses every cutoff
  // for any plausible `now`.
  return new Date(Date.UTC(2020, 0, 1) - daysAgo * 24 * 60 * 60 * 1000);
}

const SKEWED_NOW = new Date('2036-01-01T00:00:00.000Z');

describe('the keep-newest floor survives a skewed clock', () => {
  it('keeps the newest three by recorded timestamp when every object misses every cutoff', () => {
    const objects = [
      { key: 'backups/db/oldest.dump', lastModified: ancient(40) },
      { key: 'backups/db/newest.dump', lastModified: ancient(0) },
      { key: 'backups/db/fourth.dump', lastModified: ancient(30) },
      { key: 'backups/db/second.dump', lastModified: ancient(10) },
      { key: 'backups/db/third.dump', lastModified: ancient(20) },
    ];

    const decisions = retentionDecisions(objects, SKEWED_NOW);

    expect(decisions.keep.sort()).toEqual([
      'backups/db/newest.dump',
      'backups/db/second.dump',
      'backups/db/third.dump',
    ]);
    expect(decisions.delete.sort()).toEqual(['backups/db/fourth.dump', 'backups/db/oldest.dump']);
  });

  it('never deletes anything when the bucket holds the floor count or fewer', () => {
    const objects = [
      { key: 'backups/db/a.dump', lastModified: ancient(2) },
      { key: 'backups/db/b.dump', lastModified: ancient(1) },
    ];

    const decisions = retentionDecisions(objects, SKEWED_NOW);

    expect(decisions.delete).toEqual([]);
    expect(decisions.keep.sort()).toEqual(['backups/db/a.dump', 'backups/db/b.dump']);
  });

  it('exposes a floor of at least three', () => {
    expect(RETENTION_KEEP_NEWEST).toBeGreaterThanOrEqual(3);
  });
});

describe('the just-written dump is always in the kept set', () => {
  it('keeps a protected key even when the bucket reports it as the oldest object', () => {
    // A restored/copied object can carry a wrong LastModified; the run's own dump must not
    // depend on the bucket's clock to survive the pass that follows its upload.
    const justWritten = 'backups/db/db-2026-08-20-abcdef.dump';
    const objects = [
      { key: justWritten, lastModified: ancient(500) },
      { key: 'backups/db/one.dump', lastModified: ancient(1) },
      { key: 'backups/db/two.dump', lastModified: ancient(2) },
      { key: 'backups/db/three.dump', lastModified: ancient(3) },
      { key: 'backups/db/four.dump', lastModified: ancient(4) },
    ];

    const decisions = retentionDecisions(objects, SKEWED_NOW, { protectedKeys: [justWritten] });

    expect(decisions.keep).toContain(justWritten);
    expect(decisions.delete).not.toContain(justWritten);
    // The floor still applies alongside the protection.
    expect(decisions.keep).toContain('backups/db/one.dump');
    expect(decisions.delete).toContain('backups/db/four.dump');
  });

  it('a protected key absent from the listing does not corrupt the partition', () => {
    const objects = [{ key: 'backups/db/only.dump', lastModified: ancient(1) }];

    const decisions = retentionDecisions(objects, SKEWED_NOW, {
      protectedKeys: ['backups/db/not-listed-yet.dump'],
    });

    expect(decisions.keep).toEqual(['backups/db/only.dump']);
    expect(decisions.delete).toEqual([]);
  });
});

describe('keep and delete stay an exact partition of the listing', () => {
  it('every listed key lands in exactly one bucket', () => {
    const objects = Array.from({ length: 10 }, (_, index) => ({
      key: `backups/db/db-${index}.dump`,
      lastModified: ancient(index * 5),
    }));

    const decisions = retentionDecisions(objects, SKEWED_NOW);
    const union = [...decisions.keep, ...decisions.delete].sort();

    expect(union).toEqual(objects.map((object) => object.key).sort());
    expect(decisions.keep.filter((key) => decisions.delete.includes(key))).toEqual([]);
  });
});
