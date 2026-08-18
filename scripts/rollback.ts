/**
 * Roll the main Navroop Coolify app back to the previous git-sha image.
 * Does not revert the database — restore from backup separately.
 *
 *   pnpm exec tsx scripts/rollback.ts
 *   pnpm exec tsx scripts/rollback.ts --sha <gitsha>
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getCoolifyClient } from '../lib/coolify/client.ts';
import { currentRelease, parseReleaseHistory } from '../lib/deploy/release.ts';
import { executeCoolifyRollback, planRollback, ROLLBACK_CONFIRM_PHRASE } from '../lib/deploy/rollback.ts';
import { prisma } from '../lib/db.ts';
import { getSelfIdentity, SELF_UUID_NOT_CONFIGURED } from '../lib/runtime/self.ts';

const shaFlag = process.argv.includes('--sha') ? process.argv[process.argv.indexOf('--sha') + 1] : undefined;
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
const confirmation = await rl.question(`Type "${ROLLBACK_CONFIRM_PHRASE}" to roll back the Navroop app: `);
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
  imageTag: plan.target.sha,
});

if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}

console.log(`Rollback requested to ${plan.target.sha}. Database was not reverted.`);
console.log('If schema changed, restore from backup: npx tsx scripts/restore-db.ts --key …');
await prisma.$disconnect();
