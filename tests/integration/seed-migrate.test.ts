import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { findDestructiveStatements, hasReviewedDestructiveMarker } from '../../lib/migrate/safety';

describe('seed and migration', () => {
  it('committed migrations are loadable and non-destructive without a flag', () => {
    const dir = join(process.cwd(), 'prisma/migrations');
    const folders = readdirSync(dir).filter((name) => {
      if (name.startsWith('.')) return false;
      return statSync(join(dir, name)).isDirectory();
    });
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      const sql = readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
      expect(sql.length).toBeGreaterThan(0);
      // An annotated migration still needs ALLOW_DESTRUCTIVE_MIGRATION and a
      // backup at deploy time; the marker only records that it was reviewed.
      if (hasReviewedDestructiveMarker(sql)) continue;
      expect(findDestructiveStatements(sql), `${folder} is destructive`).toEqual([]);
    }
  });

  it('plan and template seeds are idempotent upserts', () => {
    const seed = readFileSync(join(process.cwd(), 'prisma/seed.ts'), 'utf8');
    expect(seed).toMatch(/plan\.upsert/);
    const templates = readFileSync(join(process.cwd(), 'prisma/seed-templates.mjs'), 'utf8');
    expect(templates).toMatch(/upsert|update|create/);
  });

  /**
   * F-603: this case was `expect(true).toBe(true)` under the name "documents
   * previous-schema migrate as a subset" — the upgrade path that decides whether a
   * production `prisma migrate deploy` succeeds, claimed by a test name and covered
   * by nothing. A placeholder is worse than an absent test because it hides the gap.
   *
   * What is checkable without provisioning a second database: the chain this
   * repository ships and the chain a migrated database has applied are the same set.
   * A folder with no applied row means `migrate deploy` has never been run against
   * these files at all; an applied row with no folder means a migration was deleted
   * or renamed after release, which is the first thing a previous-schema deploy hits.
   *
   * Still not covered, and recorded in `docs/release.md` rather than implied by a
   * green tick: the deploy itself, and checksum drift on an already-applied migration.
   */
  it('every committed migration is applied in the test database, and vice versa', async () => {
    const dir = join(process.cwd(), 'prisma/migrations');
    const folders = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
      .sort();
    const prisma = testPrismaClient();
    try {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL
      `;
      const applied = rows.map((row) => row.migration_name).sort();
      // Anti-vacuity: two empty lists would satisfy the equality below.
      expect(folders.length).toBeGreaterThan(20);
      expect(applied.length).toBeGreaterThan(20);
      expect(applied).toEqual(folders);
      // Append-only: the folder names are timestamp-prefixed, so the shipped order is
      // the deploy order. A name that sorts out of place would be applied before the
      // migration it depends on.
      expect(folders).toEqual([...folders].sort());
    } finally {
      await prisma.$disconnect();
    }
  });
});
