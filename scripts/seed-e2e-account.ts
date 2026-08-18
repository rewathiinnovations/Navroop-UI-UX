/**
 * Seed the Playwright E2E account into the application database.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/seed-e2e-account.ts
 *
 * `e2e/auth.setup.ts` calls the same function, so running this by hand is only
 * needed when you want to check the guards or re-seed without launching a
 * browser. Prints the email; never the password.
 */
import { seedE2eAccount } from '../e2e/support/seed-account.ts';

try {
  const result = await seedE2eAccount();
  console.log(
    `${result.created ? 'Created' : 'Refreshed'} E2E account ${result.account.email} in database ${result.database}`,
  );
} catch (error) {
  console.error(`[seed-e2e-account] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
