/**
 * Roll the main Navroop Coolify app back to a previous release by pinning the
 * application's `git_commit_sha` to that commit and deploying it. The pin is verified
 * before anything is deployed, and it is sticky: Coolify keeps deploying this commit
 * until a newer one is set. Does not revert the database — restore from backup
 * separately.
 *
 *   pnpm exec tsx scripts/rollback.ts
 *   pnpm exec tsx scripts/rollback.ts --sha <gitsha>
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getCoolifyClient } from '../lib/coolify/client.ts';
import { currentRelease, parseReleaseHistory } from '../lib/deploy/release.ts';
import {
  executeCoolifyRollback,
  planRollback,
  ROLLBACK_CONFIRM_PHRASE,
} from '../lib/deploy/rollback.ts';
import { prisma } from '../lib/db.ts';
import { getSelfIdentity, SELF_UUID_NOT_CONFIGURED } from '../lib/runtime/self.ts';

const shaFlag = process.argv.includes('--sha')
  ? process.argv[process.argv.indexOf('--sha') + 1]
  : undefined;
const appUuid = getSelfIdentity().coolifyAppUuid;

if (!appUuid) {
  console.error(SELF_UUID_NOT_CONFIGURED);
  process.exit(1);
}

const client = await getCoolifyClient();
if (!client) {
  console.error('Coolify is not connected. Configure it in /admin/integrations.');
  process.exit(1);
}

const current = currentRelease();
const historyRow = await prisma.appSetting.findUnique({ where: { key: 'deploy.history' } });
const history = parseReleaseHistory(historyRow?.value);
const rl = createInterface({ input: stdin, output: stdout });
const confirmation = await rl.question(
  `Type "${ROLLBACK_CONFIRM_PHRASE}" to roll back the Navroop app: `,
);
rl.close();

const plan = planRollback({
  currentSha: current.sha,
  targetSha: shaFlag,
  confirmation,
  history,
});

if (!plan.ok) {
  console.error(plan.error);
  process.exit(1);
}

const result = await executeCoolifyRollback({
  request: client.request,
  applicationUuid: appUuid,
  targetSha: plan.target.sha,
});

if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}

// The pin is verified; the build is not. Say what actually happened.
console.log(
  `Coolify is pinned to ${result.sha} and deploying it${result.deploymentUuid ? ` (deployment ${result.deploymentUuid})` : ''}.`,
);
console.log(
  'Watch the deployment in Coolify to confirm it finishes. The application stays pinned to this commit until you deploy a newer one.',
);
console.log(
  'Database was not reverted. If schema changed, restore from backup: npx tsx scripts/restore-db.ts --key …',
);
await prisma.$disconnect();
