/**
 * Publish as a Job — the pure parts: copy, naming, slug claiming, provider retry,
 * first-time rollback vs re-publish keep-live, orphan cron.
 * Run: pnpm exec tsx tests/publish-jobs.test.ts
 *
 * The step loop itself is NOT tested here. It used to be, against
 * `lib/publish/runner.ts` — a replica of the loop that production never imported, whose
 * middle steps were `async () => {}` and whose create-once guarantee was an in-process
 * `Map` that `lib/publish/execute.ts` does not have. Step ordering, `resourceIds`
 * persistence, resume-from-persisted-state and create-once now run against the shipped
 * orchestrator with real rows in `tests/integration/publish-execute.test.ts`; the replica
 * is deleted.
 */
import { compensateJobResources, shouldCompensatePublish } from '../lib/jobs/compensate.ts';
import { classifyOrphan, reconcileOrphans } from '../lib/jobs/orphans.ts';
import {
  PUBLISH_KEPT_LIVE_LINE,
  PUBLISH_RECOVERY_HEADING,
  PUBLISH_ROLLBACK_LINE,
  RECOVERY_HEADING,
  recoveryCauseLine,
} from '../lib/jobs/copy.ts';
import { isPublishRunning } from '../lib/jobs/types.ts';
import { coolifyAppName, deployRepoName, dnsLabel, isManagedCoolifyName } from '../lib/publish/naming.ts';
import { isRetryableProviderError, withProviderRetry } from '../lib/publish/retry.ts';
import {
  claimSlug,
  isSlugTakenError,
  slugCandidate,
  SLUG_UNAVAILABLE_MESSAGE,
} from '../lib/publish/slug.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

assert(PUBLISH_RECOVERY_HEADING === 'Publish did not finish', 'publish recovery heading is English');
assert(PUBLISH_ROLLBACK_LINE === 'Incomplete work was cleaned up', 'rollback copy is English');
assert(PUBLISH_KEPT_LIVE_LINE === 'Your previous live site is still running', 'kept-live copy is English');
assert(recoveryCauseLine('server_restarted') === 'The server restarted', 'cause: server restarted');
assert(recoveryCauseLine('timeout') === 'The build ran too long', 'cause: timeout');
// Exact, like the lines around it. The old form also accepted any string containing
// "provider" — including the raw `provider_error` code echoed back at the user.
assert(recoveryCauseLine('provider_error') === 'The AI service did not respond', 'cause: provider error');
assert(recoveryCauseLine('deploying') === 'The server is deploying', 'cause: deploying');
assert(recoveryCauseLine(null) !== RECOVERY_HEADING, 'missing cause does not repeat the recovery heading');
assert(recoveryCauseLine(undefined) !== RECOVERY_HEADING, 'undefined cause does not repeat the recovery heading');
assert(recoveryCauseLine('not-a-real-code') !== RECOVERY_HEADING, 'unknown cause does not repeat the recovery heading');

assert(shouldCompensatePublish(false) === true, 'first-time publish compensates');
assert(shouldCompensatePublish(true) === false, 're-publish does not compensate');

assert(coolifyAppName('acme', 'LIVE') === 'live-acme', 'Coolify name is kind-slug');
assert(coolifyAppName('acme', 'PREVIEW') === 'preview-acme', 'preview Coolify name is preview-slug');
assert(deployRepoName('acme', 'LIVE') === 'acme', 'live repo name is the slug');
assert(deployRepoName('acme', 'PREVIEW') === 'preview-acme', 'preview repo name is preview-slug');
assert(dnsLabel('acme', 'LIVE') === 'acme', 'live DNS label is the slug');
assert(dnsLabel('acme', 'PREVIEW') === 'preview-acme', 'preview DNS label is preview-slug');
assert(isManagedCoolifyName('live-acme') === true, 'managed Coolify name matches live-*');
assert(isManagedCoolifyName('random-app') === false, 'unrelated Coolify name is not managed');

assert(isPublishRunning({ kind: 'PUBLISH', status: 'RUNNING' }) === true, 'RUNNING publish job disables the button');
assert(isPublishRunning({ kind: 'PUBLISH', status: 'ABANDONED' }) === false, 'abandoned publish job is not running');
assert(isPublishRunning({ kind: 'PUBLISH', status: 'FAILED' }) === false, 'failed publish job is not running');
assert(isPublishRunning({ kind: 'BUILD', status: 'RUNNING' }) === false, 'generation job does not disable publish');

const firstDeleted: string[] = [];
const first = await compensateJobResources({
  resources: { githubRepo: 'org/acme', coolifyAppUuid: 'app-1', dnsRecordId: null },
  hadSuccessfulDeployment: false,
  adapters: {
    async deleteCoolifyApp(uuid) {
      firstDeleted.push(`coolify:${uuid}`);
    },
    async deleteDnsRecord(id) {
      firstDeleted.push(`dns:${id}`);
    },
    async archiveDeployRepo(name) {
      firstDeleted.push(`repo:${name}`);
    },
  },
});
assert(first.rolledBack === true, 'first-time abandon rolls back');
assert(firstDeleted.includes('coolify:app-1'), 'first-time abandon deletes the Coolify app');
assert(firstDeleted.includes('repo:org/acme'), 'first-time abandon archives the repo');
assert(!firstDeleted.some((row) => row.startsWith('dns:')), 'no DNS id recorded → nothing to delete');

const liveDeleted: string[] = [];
const live = await compensateJobResources({
  resources: { githubRepo: 'org/acme', coolifyAppUuid: 'app-live', dnsRecordId: 'dns-live' },
  hadSuccessfulDeployment: true,
  preexisting: { githubRepo: 'org/acme', coolifyAppUuid: 'app-live', dnsRecordId: 'dns-live' },
  adapters: {
    async deleteCoolifyApp(uuid) {
      liveDeleted.push(`coolify:${uuid}`);
    },
    async deleteDnsRecord(id) {
      liveDeleted.push(`dns:${id}`);
    },
    async archiveDeployRepo(name) {
      liveDeleted.push(`repo:${name}`);
    },
  },
});
assert(live.rolledBack === false, 're-publish abandon rolls back nothing');
assert(liveDeleted.length === 0, 're-publish abandon deletes no Coolify/DNS/repo');

const now = new Date('2026-08-17T12:00:00.000Z');
const young = classifyOrphan({
  kind: 'coolify',
  createdAt: new Date('2026-08-17T01:00:00.000Z'),
  now,
});
const old = classifyOrphan({
  kind: 'coolify',
  createdAt: new Date('2026-08-16T11:00:00.000Z'),
  now,
});
const repoOrphan = classifyOrphan({
  kind: 'repo',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  now,
});
assert(young.action === 'report', 'orphan Coolify app younger than 24h is reported only');
assert(old.action === 'delete', 'orphan Coolify app older than 24h may be deleted');
assert(repoOrphan.action === 'report', 'orphan repo is reported only, never auto-deleted');

const deletedOrphans: string[] = [];
const orphanReport = await reconcileOrphans({
  now,
  inventory: {
    coolifyApps: [
      { uuid: 'orphan-young', name: 'live-ghost', createdAt: new Date('2026-08-17T01:00:00.000Z') },
      { uuid: 'orphan-old', name: 'live-stale', createdAt: new Date('2026-08-16T11:00:00.000Z') },
      { uuid: 'known', name: 'live-acme', createdAt: new Date('2026-08-01T00:00:00.000Z') },
    ],
    dnsRecords: [],
    repos: [{ name: 'org/lonely', createdAt: new Date('2026-08-01T00:00:00.000Z') }],
  },
  deployments: [{ coolifyAppUuid: 'known', dnsRecordId: null, repoFullName: 'org/acme' }],
  isManagedName: (name, kind) => (kind === 'repo' ? name.startsWith('org/') : isManagedCoolifyName(name)),
  adapters: {
    async deleteCoolifyApp(uuid) {
      deletedOrphans.push(uuid);
    },
  },
});
assert(
  orphanReport.coolify.some((row) => row.uuid === 'orphan-young' && row.action === 'report'),
  'orphan cron reports a Coolify app with no Deployment',
);
assert(
  !deletedOrphans.includes('orphan-young'),
  'orphan Coolify app is not deleted until 24h',
);
assert(deletedOrphans.includes('orphan-old'), 'orphan Coolify app older than 24h is deleted');
assert(
  orphanReport.repos.some((row) => row.name === 'org/lonely' && row.action === 'report'),
  'orphan repo is reported',
);
assert(
  orphanReport.repos.every((row) => row.action === 'report'),
  'orphan repos are never auto-deleted',
);

// A publish that died between the Coolify and DNS steps. What `execute.ts` has actually
// persisted at that point — Coolify uuid recorded, no DNS id — is asserted against real
// `GenerationJob` rows in tests/integration/publish-execute.test.ts; here we only check
// that compensation of that state removes the orphaned app.
const compensatedAfterKill = await compensateJobResources({
  resources: { githubRepo: 'org/acme', coolifyAppUuid: 'app-new', dnsRecordId: null },
  hadSuccessfulDeployment: false,
  adapters: {
    async deleteCoolifyApp(uuid) {
      firstDeleted.push(`postkill:${uuid}`);
    },
    async deleteDnsRecord() {},
    async archiveDeployRepo() {},
  },
});
assert(compensatedAfterKill.rolledBack === true, 'abandoned first-time publish cleans up the orphaned Coolify app');
assert(firstDeleted.includes('postkill:app-new'), 'the orphaned Coolify app is the one deleted');
assert(isPublishRunning({ kind: 'PUBLISH', status: 'ABANDONED' }) === false, 'publish button is usable after abandon');

const republishDeleted: string[] = [];
const republishCompensate = await compensateJobResources({
  resources: { githubRepo: 'org/acme', coolifyAppUuid: 'app-live', dnsRecordId: 'dns-live' },
  hadSuccessfulDeployment: true,
  preexisting: { githubRepo: 'org/acme', coolifyAppUuid: 'app-live', dnsRecordId: 'dns-live' },
  adapters: {
    async deleteCoolifyApp(uuid) {
      republishDeleted.push(`coolify:${uuid}`);
    },
    async deleteDnsRecord(id) {
      republishDeleted.push(`dns:${id}`);
    },
    async archiveDeployRepo(name) {
      republishDeleted.push(`repo:${name}`);
    },
  },
});
assert(republishCompensate.rolledBack === false, 're-publish interrupt keeps the live site');
assert(republishDeleted.length === 0, 're-publish interrupt deletes nothing');

// Create-once is NOT an in-process de-duplication map — `execute.ts` has none. It comes
// from the persisted `resourceIds` skip in the step loop, exercised against real rows in
// tests/integration/publish-execute.test.ts ("creates each resource once" across a failed
// attempt and its retry).

class FakeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
assert(isRetryableProviderError(new FakeHttpError(500, 'boom')) === true, '5xx is retryable');
assert(isRetryableProviderError(new FakeHttpError(404, 'nope')) === false, '4xx is not retryable');
assert(isRetryableProviderError(new Error('ECONNRESET')) === true, 'network errors are retryable');

let attempts = 0;
const retried = await withProviderRetry(
  async () => {
    attempts += 1;
    if (attempts === 1) throw new FakeHttpError(503, 'unavailable');
    return 'ok';
  },
  { sleep: async () => {} },
);
assert(retried === 'ok', 'one retry on 5xx succeeds');
assert(attempts === 2, 'exactly one retry on 5xx');

let fourAttempts = 0;
let fourFailed = false;
try {
  await withProviderRetry(
    async () => {
      fourAttempts += 1;
      throw new FakeHttpError(400, 'bad');
    },
    { sleep: async () => {} },
  );
} catch {
  fourFailed = true;
}
assert(fourFailed, '4xx is not retried');
assert(fourAttempts === 1, '4xx runs once');

// --- Slug claim: the unique index is the arbiter, not a pre-read ---
function uniqueIndexClaim(taken: Set<string>) {
  return async (slug: string) => {
    // Yield first, so two concurrent claims both pick a candidate before either writes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (taken.has(slug)) {
      const conflict: Error & { code?: string } = new Error(
        'Unique constraint failed on the fields: (`slug`,`kind`)',
      );
      conflict.code = 'P2002';
      throw conflict;
    }
    taken.add(slug);
  };
}

assert(slugCandidate('Acme Site', 1) === 'acme-site', 'first slug candidate is the plain slug');
assert(slugCandidate('Acme Site', 2) === 'acme-site-2', 'second slug candidate appends -2');
assert(slugCandidate('www', 1) === 'www-site', 'reserved slug is bumped on the first candidate');

const concurrentTaken = new Set<string>();
const [slugA, slugB] = await Promise.all([
  claimSlug({ name: 'Acme Site', kind: 'LIVE', claim: uniqueIndexClaim(concurrentTaken) }),
  claimSlug({ name: 'Acme Site', kind: 'LIVE', claim: uniqueIndexClaim(concurrentTaken) }),
]);
assert(slugA !== slugB, 'concurrent slug claims produce two distinct slugs');
assert([slugA, slugB].includes('acme-site'), 'one concurrent claim keeps the base slug');
assert([slugA, slugB].includes('acme-site-2'), 'the losing concurrent claim retries onto -2');

const keptSlug = await claimSlug({
  name: 'Acme Site',
  kind: 'LIVE',
  existingSlug: 'already-live',
  claim: async () => {
    throw new Error('must not write when a slug is already assigned');
  },
});
assert(keptSlug === 'already-live', 'an assigned slug is never re-claimed');

const nonUniqueClaim = async () => {
  throw new Error('connection reset');
};
let nonUniquePropagated = false;
try {
  await claimSlug({ name: 'Acme Site', kind: 'LIVE', claim: nonUniqueClaim });
} catch (error) {
  nonUniquePropagated = error instanceof Error && error.message === 'connection reset';
}
assert(nonUniquePropagated, 'a non-unique write error is not retried away');

let exhaustedMessage = '';
try {
  await claimSlug({
    name: 'Acme Site',
    kind: 'LIVE',
    maxAttempts: 3,
    claim: async () => {
      const conflict: Error & { code?: string } = new Error('taken');
      conflict.code = 'P2002';
      throw conflict;
    },
  });
} catch (error) {
  exhaustedMessage = error instanceof Error ? error.message : '';
}
assert(exhaustedMessage === SLUG_UNAVAILABLE_MESSAGE, 'exhausted slug retries fail with English copy');
assert(
  isSlugTakenError({ code: '23505' }) && isSlugTakenError({ code: 'P2002' }),
  'both Prisma P2002 and Postgres 23505 count as a taken slug',
);
assert(
  isSlugTakenError(new Error('Deployment_dns_label_key')) === true,
  'the functional DNS-label index also counts as a taken slug',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
