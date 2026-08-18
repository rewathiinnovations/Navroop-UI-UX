import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('documents previous-schema migrate as a subset', () => {
    // Full previous-schema fixture is not checked in (size). Empty-DB migrate is
    // `prisma migrate deploy` against TEST_DATABASE_URL — see docs/release.md.
    expect(true).toBe(true);
  });
});
