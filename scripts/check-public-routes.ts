/**
 * Verify gate for the unauthenticated API allowlist.
 *
 * Fails when `PUBLIC_API_ROUTES` picks up a wildcard path, a wildcard method,
 * or an entry without a reason or a mechanism. Prints the allowlist size on
 * success — a number that grows is worth noticing in review.
 */
import { PUBLIC_API_ROUTES, validatePublicRoutes } from '../lib/auth/public-routes.ts';

const problems = validatePublicRoutes();

if (problems.length > 0) {
  console.error('Public API allowlist is invalid:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('');
  console.error('Fix lib/auth/public-routes.ts. Every entry needs an explicit path,');
  console.error('explicit methods, a reason, and the mechanism that protects it.');
  process.exit(1);
}

const methodCount = PUBLIC_API_ROUTES.reduce((total, rule) => total + rule.methods.length, 0);
console.log(
  `Public API allowlist: ${PUBLIC_API_ROUTES.length} entries, ${methodCount} path+method pairs reachable without a session.`,
);
for (const rule of PUBLIC_API_ROUTES) {
  console.log(`  ${rule.methods.join(', ').padEnd(11)} ${rule.pattern}`);
}
