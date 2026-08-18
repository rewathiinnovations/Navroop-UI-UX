/**
 * Fail if committed migration SQL is destructive without review.
 *
 * A migration may carry the `navroop:reviewed-destructive` marker to record
 * that its rewrites were examined and are intended — an enum cannot be
 * narrowed in Postgres without retyping its columns, so the alternative is
 * never being able to remove a value. The marker only lets such a migration
 * live in the tree; `preMigrate` still demands ALLOW_DESTRUCTIVE_MIGRATION
 * and a backup at deploy time, which is where the protection matters.
 */
import { resolve } from 'node:path';
import {
  findDestructiveStatements,
  hasReviewedDestructiveMarker,
  loadMigrationSql,
} from '../lib/migrate/safety.ts';

const allow = process.env.ALLOW_DESTRUCTIVE_MIGRATION === 'true';
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
const all = await loadMigrationSql(migrationsDir);

const reviewed: string[] = [];
const offending: string[] = [];
for (const row of all) {
  const statements = findDestructiveStatements(row.sql);
  if (statements.length === 0) continue;
  if (hasReviewedDestructiveMarker(row.sql)) {
    reviewed.push(...statements);
    continue;
  }
  offending.push(...statements);
}

if (offending.length > 0 && !allow) {
  console.error(
    'Destructive migration detected. Review it and add the navroop:reviewed-destructive marker, or set ALLOW_DESTRUCTIVE_MIGRATION=true.',
  );
  for (const statement of offending) {
    console.error(`  ${statement}`);
  }
  process.exit(1);
}

if (offending.length > 0) {
  console.log('Destructive SQL allowed by flag.');
} else if (reviewed.length > 0) {
  console.log(`No unreviewed destructive SQL (${reviewed.length} reviewed statement(s)).`);
} else {
  console.log('No destructive SQL in committed migrations.');
}
