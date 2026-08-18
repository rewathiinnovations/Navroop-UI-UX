/**
 * Fail if committed migration SQL is destructive without ALLOW_DESTRUCTIVE_MIGRATION=true.
 */
import { resolve } from 'node:path';
import { findDestructiveStatements, loadMigrationSql } from '../lib/migrate/safety.ts';

const allow = process.env.ALLOW_DESTRUCTIVE_MIGRATION === 'true';
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
const all = await loadMigrationSql(migrationsDir);
const offending = all.flatMap((row) => findDestructiveStatements(row.sql));

if (offending.length > 0 && !allow) {
  console.error('Destructive migration detected. Set ALLOW_DESTRUCTIVE_MIGRATION=true only after review.');
  for (const statement of offending) {
    console.error(`  ${statement}`);
  }
  process.exit(1);
}

console.log(
  offending.length === 0
    ? 'No destructive SQL in committed migrations.'
    : 'Destructive SQL allowed by flag.',
);
