/**
 * Create openlovable_test and openlovable_shadow on the local Postgres (5433) when missing.
 * Never points tests at the development database name. Shadow is disposable (Prisma may wipe it).
 */
import { ensurePostgresDatabase } from '../lib/verify/ensure-db.ts';

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ||
  'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable';
const testName = process.env.TEST_DATABASE_NAME || 'openlovable_test';
const shadowName = process.env.SHADOW_DATABASE_NAME || 'openlovable_shadow';

for (const name of [testName, shadowName]) {
  const result = ensurePostgresDatabase({ adminUrl, name });
  if (!result.ok) {
    console.error(result.output);
    process.exit(1);
  }
  console.log(result.created ? `Created database ${name}` : result.output);
}
