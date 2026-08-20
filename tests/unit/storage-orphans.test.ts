import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Nothing in the product ever looked at two of the three prefixes it writes. The weekly
 * storage check diffed `snapshots/` against `Checkpoint`, embedded the resulting orphan list
 * in `BackupRun.detail` uncapped, and then ignored it: `ok` did not consider it and no cron
 * deleted anything, so abandoned objects were billed forever (F-781). `previews/` and
 * `projects/` had no equivalent diff at all, so the failure that motivated the snapshot check
 * would have gone unseen there (F-172).
 *
 * Two properties matter more than the counting:
 *
 * 1. An object is only ever *considered* if it sits under a declared scope whose reference set
 *    this module knows how to build. Coverage is asserted against the repository below, so a
 *    new upload path with a new prefix fails this file rather than silently making live files
 *    look abandoned.
 * 2. Nothing recent is deleted. Every writer uploads bytes seconds before committing the row
 *    that points at them, so "unreferenced" is only true of an object older than any plausible
 *    in-flight write. The grace period is what makes deletion safe, and deletion is opt-in.
 *
 * Goes red if: a prefix loses its diff; the orphan list goes back into `detail` unbounded; the
 * delete pass loses its grace window, its per-run cap, or its opt-in; or a new storage prefix
 * appears with no scope.
 */

const storage = vi.hoisted(() => ({ listObjects: vi.fn(), deleteObject: vi.fn() }));
const settings = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock('@/lib/storage', () => ({
  listObjects: storage.listObjects,
  deleteObject: storage.deleteObject,
}));

vi.mock('@/lib/settings/resolve', () => ({ getSettings: settings.getSettings }));

const { ORPHAN_SCOPES, ORPHAN_SAMPLE_LIMIT, ORPHAN_DELETE_LIMIT, scanOrphans, storageKeyFromUrl } =
  await import('@/lib/backup/orphans.ts');

const NOW = new Date('2026-08-20T00:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');
const FRESH = new Date('2026-08-19T23:00:00.000Z');

function object(key: string, lastModified: Date, sizeBytes = 100) {
  return { key, sizeBytes, lastModified };
}

/** No references anywhere, so every listed object is an orphan candidate. */
function emptyReferences() {
  return new Map(
    ORPHAN_SCOPES.map((scope) => [
      scope.prefix,
      { keys: new Set<string>(), prefixes: [] as string[] },
    ]),
  );
}

beforeEach(() => {
  storage.listObjects.mockReset();
  storage.deleteObject.mockReset();
  settings.getSettings.mockReset();
  storage.listObjects.mockResolvedValue([]);
  storage.deleteObject.mockResolvedValue(undefined);
  settings.getSettings.mockResolvedValue({
    'storage.orphanGraceDays': '14',
    'storage.orphanAction': 'report',
  });
});

describe('scope coverage', () => {
  it('covers every prefix this product uploads to', () => {
    // Scanned out of the repository rather than listed, because the failure this guards is a
    // *new* upload path: a prefix with no scope is never diffed, so its abandoned objects are
    // billed forever (the original F-172), and a prefix whose scope exists but whose
    // reference builder does not would make live files look orphaned.
    const found = new Map<string, string[]>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(path, 'utf8');
        // Only files that reach object storage, so a generated-code path like
        // `components/${name}` in the import pipeline is not mistaken for a storage key.
        if (!/from '@\/lib\/storage'|\bupload\(|StorageKey\s*\(|ObjectKey\s*\(/.test(text)) {
          continue;
        }
        for (const match of text.matchAll(/(?:return|=)\s*`([a-z][a-z0-9-]*)\/\$\{/g)) {
          found.set(`${match[1]}/`, [...(found.get(`${match[1]}/`) ?? []), path]);
        }
      }
    };
    walk(join(process.cwd(), 'lib'));

    const declared = ORPHAN_SCOPES.map((scope) => scope.prefix).sort();
    expect([...found.keys()].sort()).toEqual(declared);
    // Sanity: the scan found something at all, so the assertion above cannot pass vacuously.
    expect(declared.length).toBe(5);
  });

  it('recovers a storage key from a stored public URL', () => {
    expect(storageKeyFromUrl('/uploads/projects/p1/assets/abc.webp')).toBe(
      'projects/p1/assets/abc.webp',
    );
    expect(storageKeyFromUrl('https://cdn.example.com/bucket/users/u1/avatar/x.webp?v=2')).toBe(
      'users/u1/avatar/x.webp',
    );
    expect(storageKeyFromUrl('https://example.com/not-a-storage-url.png')).toBe(null);
    expect(storageKeyFromUrl(null)).toBe(null);
  });
});

describe('scanOrphans', () => {
  it('finds an unreferenced object under every scanned prefix', async () => {
    storage.listObjects.mockImplementation(async (prefix: string) => [
      object(`${prefix}abandoned`, OLD),
    ]);

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    for (const scope of report.scopes) {
      expect(scope.orphans).toBe(1);
      expect(scope.sample).toEqual([`${scope.prefix}abandoned`]);
    }
    expect(report.totals.orphans).toBe(ORPHAN_SCOPES.length);
    expect(report.totals.orphanBytes).toBe(100 * ORPHAN_SCOPES.length);
  });

  it('treats an object under a referenced preview prefix as live', async () => {
    const references = emptyReferences();
    references.set('previews/', { keys: new Set(), prefixes: ['previews/p1/b1'] });
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'previews/'
        ? [object('previews/p1/b1/index.html', OLD), object('previews/p1/b0/index.html', OLD)]
        : [],
    );

    const report = await scanOrphans({ now: NOW, references });
    const previews = report.scopes.find((scope) => scope.prefix === 'previews/');

    expect(previews?.scanned).toBe(2);
    expect(previews?.orphans).toBe(1);
    expect(previews?.sample).toEqual(['previews/p1/b0/index.html']);
  });

  it('does not count a referenced key as an orphan', async () => {
    const references = emptyReferences();
    references.set('snapshots/', { keys: new Set(['snapshots/p1/cp1.json.gz']), prefixes: [] });
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/' ? [object('snapshots/p1/cp1.json.gz', OLD)] : [],
    );

    const report = await scanOrphans({ now: NOW, references });

    expect(report.totals.orphans).toBe(0);
  });

  it('caps the sample it is willing to write into a run row', async () => {
    const many = Array.from({ length: ORPHAN_SAMPLE_LIMIT + 25 }, (_unused, index) =>
      object(`snapshots/p1/cp${index}.json.gz`, OLD),
    );
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/' ? many : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });
    const snapshots = report.scopes.find((scope) => scope.prefix === 'snapshots/');

    expect(snapshots?.orphans).toBe(many.length);
    expect(snapshots?.sample).toHaveLength(ORPHAN_SAMPLE_LIMIT);
  });

  it('deletes nothing while the action is report only', async () => {
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/' ? [object('snapshots/p1/gone.json.gz', OLD)] : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    expect(report.action).toBe('report');
    expect(report.totals.deleted).toBe(0);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    // Still reclaimable, so the operator can see what switching the setting would remove.
    expect(report.totals.reclaimable).toBe(1);
  });

  it('deletes only objects past the grace period once the operator opts in', async () => {
    settings.getSettings.mockResolvedValue({
      'storage.orphanGraceDays': '14',
      'storage.orphanAction': 'delete',
    });
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/'
        ? [object('snapshots/p1/old.json.gz', OLD), object('snapshots/p1/new.json.gz', FRESH)]
        : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith('snapshots/p1/old.json.gz');
    expect(report.totals.deleted).toBe(1);
    expect(report.totals.reclaimedBytes).toBe(100);
    // The fresh one is still an orphan by reference, just not reclaimable yet.
    expect(report.totals.orphans).toBe(2);
    expect(report.totals.reclaimable).toBe(1);
  });

  it('never deletes an object whose age is unknown', async () => {
    settings.getSettings.mockResolvedValue({
      'storage.orphanGraceDays': '14',
      'storage.orphanAction': 'delete',
    });
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/'
        ? [{ key: 'snapshots/p1/x.json.gz', sizeBytes: 5, lastModified: null }]
        : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(report.totals.deleted).toBe(0);
  });

  it('stops at the per-run delete cap instead of an unbounded loop', async () => {
    settings.getSettings.mockResolvedValue({
      'storage.orphanGraceDays': '14',
      'storage.orphanAction': 'delete',
    });
    const many = Array.from({ length: ORPHAN_DELETE_LIMIT + 10 }, (_unused, index) =>
      object(`snapshots/p1/cp${index}.json.gz`, OLD),
    );
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/' ? many : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    expect(storage.deleteObject).toHaveBeenCalledTimes(ORPHAN_DELETE_LIMIT);
    expect(report.totals.deleted).toBe(ORPHAN_DELETE_LIMIT);
    expect(report.truncated).toBe(true);
  });

  it('one failed delete costs one object, not the pass', async () => {
    settings.getSettings.mockResolvedValue({
      'storage.orphanGraceDays': '14',
      'storage.orphanAction': 'delete',
    });
    storage.deleteObject.mockRejectedValueOnce(new Error('AccessDenied'));
    storage.listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'snapshots/'
        ? [object('snapshots/p1/a.json.gz', OLD), object('snapshots/p1/b.json.gz', OLD)]
        : [],
    );

    const report = await scanOrphans({ now: NOW, references: emptyReferences() });

    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(report.totals.deleted).toBe(1);
    expect(report.totals.deleteFailed).toBe(1);
    // Bytes are only reclaimed for objects that actually went away.
    expect(report.totals.reclaimedBytes).toBe(100);
  });
});
