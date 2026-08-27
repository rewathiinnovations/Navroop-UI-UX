import { prisma } from '@/lib/db';
import {
  addApplicationDomain,
  COOLIFY_STATUS_UNREPORTED,
  createApplication,
  getCoolifyDeployment,
  pinApplicationCommit,
  triggerDeploy,
  type CoolifyServerAuth,
  type CreateApplicationInput,
  type DeploymentHealth,
} from '@/lib/coolify/client';
import { pickCoolifyServer, serverAuth } from '@/lib/coolify/servers';
import { upsertARecord } from '@/lib/cloudflare/dns';
import { applyPrimaryRedirects, type RedirectOutcome } from '@/lib/domains/redirects';
import { ensureDeployRepo, pushFiles, type PushFileEntry } from '@/lib/github/deploy-client';
import { getRootDomain } from '@/lib/integrations/store';
import { getStack } from '@/lib/stacks';
import { buildRepoFiles } from '@/lib/deploy/repo-files';
import { deriveDeploymentStatus } from './deployment-status';
import { beginJobHeartbeat, failJob, markJobRunning, succeedJob } from '@/lib/jobs/lifecycle';
import { HEARTBEAT_STALE_MS } from '@/lib/jobs/poll';
import { claimJobRun, getJob, updateJobFields } from '@/lib/jobs/store';
import { getInstanceId } from '@/lib/runtime/instance';
import type { JobResourceIds, JobStep } from '@/lib/jobs/types';
import { log } from '@/lib/logger';
import {
  DEFAULT_DEPLOY_BRANCH,
  PUBLISH_POLL_MS,
  PUBLISH_POLL_TIMEOUT_MS,
  PUBLISH_UNREPORTED_RETRY_MS,
  PUBLISH_UNREPORTED_STATUS_READS,
} from './constants';
import { collectPublishAssets, type PublishAssetFile } from './assets';
import { collectPublishFiles, publishJobErrorCode, withoutNeverPublishedPaths } from './files';
import { injectPreviewFiles } from './preview-inject';
import { coolifyAppName, dnsLabel, deployRepoName } from './naming';
import { withProviderRetry } from './retry';
import {
  evaluateRepoGuard,
  PublishRepoConflictError,
  readDeploymentGithubRepoId,
  recordDeploymentGithubRepo,
  type EnsuredRepo,
} from './repo-guard';
import { claimSlug, hostForSlug, urlForSlug } from './slug';
import { PUBLISH_STEPS } from './steps';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A `CoolifyServer` row, narrowed to the columns the publish loop reads. */
export type PublishServer = {
  id: string;
  apiUrl: string;
  apiToken: string;
  serverIp: string;
  projectUuid: string;
};

/**
 * Every external system the ten-step loop talks to, in one injectable bundle.
 *
 * Production calls `runPublishJob(jobId)` and gets `livePublishDeps` — the real Coolify,
 * GitHub App and Cloudflare clients. The seam exists so a test can drive *this* loop:
 * without it the only way to exercise step ordering, resource persistence and resume was
 * a hand-written replica of the loop, and a replica cannot go red when this file
 * regresses. Every member is required, so adding one is a compile error in the tests
 * rather than a silent fall back to a live provider call.
 */
export type PublishDeps = {
  collectFiles: (projectId: string) => Promise<Record<string, string>>;
  /**
   * The project's images, keyed by the repo path that makes the deployed site serve them
   * at the URL the generated markup already points at (F-262). Injected for the same
   * reason `collectFiles` is: the assembly below is what has to be provable, and a
   * failure here must fail the publish rather than ship a page full of broken images.
   */
  collectAssets: (input: {
    projectId: string;
    stack: string;
    files: Record<string, string>;
  }) => Promise<Record<string, PublishAssetFile>>;
  pickServer: () => Promise<PublishServer>;
  rootDomain: (workspaceId: string) => Promise<string>;
  /** Find-or-create; the returned id and `created` flag feed the F-202 ownership guard. */
  ensureRepo: (repoSlug: string, workspaceId: string) => Promise<EnsuredRepo>;
  /**
   * `branch` is the same value `createApp` is given. Coolify was told to build
   * `deployment.repoBranch || 'main'` while the push hardcoded `refs/heads/main`, so a
   * non-default `repoBranch` would have had Coolify deploying a branch nothing wrote (F-253).
   */
  pushFiles: (
    repoFullName: string,
    files: Record<string, PushFileEntry>,
    message: string,
    workspaceId: string,
    branch: string,
  ) => Promise<string>;
  createApp: (auth: CoolifyServerAuth, input: CreateApplicationInput) => Promise<{ uuid: string }>;
  upsertDns: (label: string, ip: string) => Promise<string>;
  /**
   * Read-modify-write: a re-publish must not PATCH the hostname list down to the publish
   * host. That silently unrouted every verified custom domain (and every primary 301)
   * while the Domains tab still showed them ACTIVE.
   */
  addAppDomain: (auth: CoolifyServerAuth, appUuid: string, host: string) => Promise<void>;
  /**
   * Re-asserts primary + alias 301s after the publish host is (re-)attached.
   *
   * Answers an outcome rather than throwing: "no live custom domain" is the normal state for
   * most publishes, and "the Cloudflare zone is unknown" is a refusal this step must not turn
   * into a failed publish — `addAppDomain` above already merged the publish host on, so the
   * site is reachable either way and the refusal is recorded on the domain row (F-207).
   */
  applyRedirects: (deploymentId: string) => Promise<RedirectOutcome>;
  /**
   * Selects the commit Coolify's next deploy builds, proven by a read-back. Runs
   * immediately before `startDeploy`; a refusal fails the step rather than deploying
   * whatever release the application happens to be pinned to (F-264).
   */
  pinCommit: (
    auth: CoolifyServerAuth,
    appUuid: string,
    sha: string,
  ) => Promise<{ ok: true; sha: string } | { ok: false; error: string }>;
  startDeploy: (
    auth: CoolifyServerAuth,
    appUuid: string,
  ) => Promise<{ deploymentUuid: string | null }>;
  /**
   * The state of the deployment `startDeploy` returned — not the application's. The
   * application is already healthy from the previous build on every re-publish, so
   * reading it reported LIVE before the new build had even started.
   */
  deploymentStatus: (
    auth: CoolifyServerAuth,
    deploymentUuid: string,
  ) => Promise<{ health: DeploymentHealth; status: string }>;
};

export const livePublishDeps: PublishDeps = {
  collectFiles: collectPublishFiles,
  collectAssets: collectPublishAssets,
  pickServer: pickCoolifyServer,
  rootDomain: getRootDomain,
  ensureRepo: ensureDeployRepo,
  pushFiles,
  createApp: createApplication,
  upsertDns: upsertARecord,
  addAppDomain: addApplicationDomain,
  applyRedirects: applyPrimaryRedirects,
  pinCommit: pinApplicationCommit,
  startDeploy: triggerDeploy,
  deploymentStatus: getCoolifyDeployment,
};

function initialSteps(): JobStep[] {
  return PUBLISH_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    error: null,
  }));
}

function patchSteps(
  steps: JobStep[],
  key: string,
  status: JobStep['status'],
  error?: string | null,
) {
  const now = new Date().toISOString();
  return steps.map((step) =>
    step.key === key
      ? {
          ...step,
          status,
          startedAt: step.startedAt ?? now,
          finishedAt: status === 'running' ? null : now,
          error: error ?? null,
        }
      : step,
  );
}

async function persistProgress(
  jobId: string,
  deploymentId: string,
  input: {
    steps: JobStep[];
    currentStep: string;
    resourceIds: JobResourceIds;
    hadSuccessfulDeployment: boolean;
    jobStatus?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED';
    extra?: {
      slug?: string;
      repoFullName?: string | null;
      commitSha?: string | null;
      coolifyAppUuid?: string | null;
      dnsRecordId?: string | null;
      serverId?: string;
      buildLogUrl?: string | null;
      url?: string | null;
      lastRequestId?: string | null;
    };
  },
) {
  await updateJobFields(jobId, {
    steps: input.steps,
    currentStep: input.currentStep,
    resourceIds: input.resourceIds,
    lastStep: input.currentStep,
  });
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: deriveDeploymentStatus(input.jobStatus ?? 'RUNNING', input.hadSuccessfulDeployment),
      progressStep: input.currentStep,
      ...(input.extra ?? {}),
    },
  });
}

/**
 * `persistProgress` only ever writes QUEUED/BUILDING/LIVE, so a failed publish job
 * used to leave the Deployment row claiming BUILDING forever. Settle it alongside
 * the job. Best effort: never mask the publish error with a bookkeeping error.
 */
async function markDeploymentFailed(
  deploymentId: string,
  message: string,
  hadSuccessfulDeployment: boolean,
) {
  try {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: deriveDeploymentStatus('FAILED', hadSuccessfulDeployment),
        lastError: message,
      },
    });
  } catch (error) {
    log.error('publish.deployment_status_write_failed', {
      deploymentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runPublishJob(jobId: string, deps: PublishDeps = livePublishDeps) {
  const job = await getJob(jobId);
  if (!job) throw new Error('Publish job not found');
  if (job.status === 'SUCCEEDED') return job;
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;

  // Claim the run before anything external happens. `startPublishJob` deliberately hands
  // a second caller the *same* job id, `acquireLock` is re-entrant for the same user, and
  // `markJobRunning`'s guard accepts a row that is already RUNNING — so a double click,
  // two tabs, or two POSTs used to put two runners on one job. Each has its own `steps`
  // and `resourceIds`, so they raced a force-push on one branch, called `triggerDeploy`
  // twice, and could create two Coolify applications for one deployment, the second of
  // which is recorded nowhere and therefore unreapable.
  //
  // A lost claim is not an error: the work is already in flight, so hand the caller the
  // in-flight job.
  const claimed = await claimJobRun(
    jobId,
    getInstanceId(),
    new Date(Date.now() - HEARTBEAT_STALE_MS),
  );
  if (!claimed) {
    log.info('publish.run_already_claimed', { jobId, projectId: job.projectId });
    return getJob(jobId);
  }

  const kind = job.inputPrompt === 'PREVIEW' ? 'PREVIEW' : 'LIVE';
  const deployment = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: job.projectId, kind } },
  });
  if (!deployment) throw new Error('Deployment row not found');

  const hadSuccessfulDeployment = Boolean(deployment.publishedAt || deployment.status === 'LIVE');
  let steps = job.steps?.length ? job.steps : initialSteps();
  const resourceIds: JobResourceIds = { ...(job.resourceIds ?? {}) };

  const heartbeat = beginJobHeartbeat(jobId);
  let project: {
    id: string;
    name: string;
    stack: string;
    designDirection: string | null;
  } | null;
  try {
    await markJobRunning(jobId, { chargeCredits: false, acquireProjectLock: false });
    project = await prisma.project.findFirst({
      where: { id: job.projectId, deletedAt: null },
      select: { id: true, name: true, stack: true, designDirection: true },
    });
  } catch (error) {
    heartbeat.stop();
    throw error;
  }
  if (!project) {
    heartbeat.stop();
    await failJob(jobId, { errorCode: 'provider_error', errorMessage: 'Project not found' });
    await markDeploymentFailed(deployment.id, 'Project not found', hadSuccessfulDeployment);
    return getJob(jobId);
  }

  const FINAL_STEP = PUBLISH_STEPS[PUBLISH_STEPS.length - 1].key;

  const step = async (key: string, work: () => Promise<void>) => {
    if (steps.find((row) => row.key === key)?.status === 'succeeded') return;
    steps = patchSteps(steps, key, 'running');
    await persistProgress(jobId, deployment.id, {
      steps,
      currentStep: key,
      resourceIds,
      hadSuccessfulDeployment,
    });
    try {
      await work();
      steps = patchSteps(steps, key, 'succeeded');
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: key,
        resourceIds,
        hadSuccessfulDeployment,
        // The `live` step has just written LIVE + publishedAt. Deriving the status from a
        // RUNNING job here wrote BUILDING straight back over it, so every successful
        // publish ended parked on BUILDING — which is what the publish sheet,
        // /deployments, the project badge and the live-slot count all read.
        jobStatus: key === FINAL_STEP ? 'SUCCEEDED' : undefined,
      });
    } catch (error) {
      steps = patchSteps(
        steps,
        key,
        'failed',
        error instanceof Error ? error.message : 'Publish failed',
      );
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: key,
        resourceIds,
        hadSuccessfulDeployment,
      });
      throw error;
    }
  };

  try {
    let files: Record<string, PushFileEntry> = {};
    const stack = getStack(project.stack);
    let slug = deployment.slug;
    let server: PublishServer = await prisma.coolifyServer.findUniqueOrThrow({
      where: { id: deployment.serverId },
    });

    // One source for both call sites below.
    //
    // `deps.collectFiles` returns the generated files and nothing else — the checkpoint
    // snapshot is `<file>` blocks from `Project.lastCode`, so a generation that did not
    // happen to emit a `package.json` produced a repo Coolify cannot build. `buildRepoFiles`
    // is what the Connectors push and the ZIP export already ship: the stack scaffold
    // underneath, the generated files on top, plus the Dockerfile / .dockerignore /
    // .gitignore / README the host needs. Publish was the one caller that skipped it.
    //
    // The never-publish deny list is re-applied to the merged set on purpose. It already
    // runs inside `collectPublishFiles`, but `collectFiles` is an injectable dependency
    // and the commit is built from explicit Git Data tree entries (a `.gitignore` in the
    // tree is decoration), so the last thing before a file becomes a commit has to be the
    // filter. Nothing `buildRepoFiles` adds is on that list.
    //
    // Project images come last, and only after the text set is final: whether an asset is
    // referenced is decided by what the commit actually contains, and its repo path is
    // whatever makes the deployed site answer the URL already written into that text
    // (F-262). They are the only entries in the set that are not text.
    //
    // The preview gate goes on top of all of it. The gate follows
    // `Deployment.passwordHash`, not the request: hardcoding `password: null` here meant
    // every publish of a node stack shipped a middleware with the Basic-Auth branch
    // stripped out while the UI kept reporting `hasPassword: true`. The plaintext never
    // reaches the deploy repo — it lives on the Coolify application as PREVIEW_PASSWORD.
    const collectForPublish = async (): Promise<Record<string, PushFileEntry>> => {
      const generated = await deps.collectFiles(job.projectId);
      const repoFiles = buildRepoFiles(stack.id, generated, {
        projectName: project.name,
        designDirection: project.designDirection,
      });
      const text =
        kind === 'PREVIEW'
          ? injectPreviewFiles(repoFiles, {
              stack: stack.id,
              deployType: stack.deployType,
              passwordProtected: Boolean(deployment.passwordHash),
            })
          : repoFiles;
      const assets = await deps.collectAssets({
        projectId: job.projectId,
        stack: stack.id,
        files: text,
      });
      return withoutNeverPublishedPaths({ ...text, ...assets });
    };

    await step('limit', async () => {});
    await step('files', async () => {
      files = await collectForPublish();
    });
    if (Object.keys(files).length === 0) {
      // A resumed job skips the already-succeeded `files` step, so nothing filled `files`.
      files = await collectForPublish();
    }
    await step('slug', async () => {
      if (hadSuccessfulDeployment) return;
      // Claim by writing, so a concurrent publish of a same-named project loses the
      // race on the unique index and retries onto `name-2` instead of surfacing a
      // raw Prisma unique-violation.
      slug = await claimSlug({
        name: project.name,
        kind,
        existingSlug: deployment.slug.startsWith('pending-') ? null : deployment.slug,
        claim: async (candidate) => {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { slug: candidate },
          });
        },
      });
      // The server is pinned by the first resource created on it. Re-picking here on
      // every unsuccessful attempt moved a retry to whichever server was least loaded
      // *now*, while `resourceIds` still carried the Coolify uuid created on the old one
      // — so the retry talked to server B's API with server A's application uuid, got a
      // 404 nobody can interpret, and left `serverId` pointing somewhere the app is not
      // (which is also how `stopDeployment` and `destroyDeployment` find it). A genuine
      // move is a migration: delete the app, recreate it, re-point DNS.
      const pinnedByResource = Boolean(
        resourceIds.coolifyAppUuid ||
        deployment.coolifyAppUuid ||
        resourceIds.dnsRecordId ||
        deployment.dnsRecordId,
      );
      if (!pinnedByResource) server = await deps.pickServer();
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'slug',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { slug, serverId: server.id },
      });
    });

    const root = await deps.rootDomain(deployment.workspaceId);
    const host = hostForSlug(slug, kind, root);
    const repoSlug = deployRepoName(slug, kind);
    // One value, read once: the push writes this ref and Coolify is told to build it.
    const branch = deployment.repoBranch || DEFAULT_DEPLOY_BRANCH;
    const auth = serverAuth(server);
    // Which commit Coolify must build. Seeded from the row so a resumed job (whose
    // `github` step already succeeded and is skipped) still knows what it pushed.
    let pushedCommitSha: string | null = deployment.commitSha ?? null;

    await step('github', async () => {
      // Always resolve the repo, even on re-publish: the guard compares the recorded
      // immutable id against the repo currently behind the name, and a repo that was
      // deleted and re-created by someone else must refuse, not be force-pushed over.
      const repo = await withProviderRetry(() => deps.ensureRepo(repoSlug, deployment.workspaceId));
      const decision = evaluateRepoGuard({
        repo,
        recordedRepoId: await readDeploymentGithubRepoId(deployment.id),
        recordedRepoFullName: deployment.repoFullName,
        hasPushedBefore: Boolean(deployment.commitSha || deployment.publishedAt),
      });
      if (decision.action === 'refuse') {
        // Typed refusal: fails this step with the full sentence (which repo, why, how to
        // proceed) and maps to the `repo_conflict` job error code in the catch below.
        throw new PublishRepoConflictError(repo.fullName);
      }
      // Record ownership before pushing — a crash after create must not leave a repo this
      // project owns but cannot prove it owns. `adopt` is the one-time pre-feature
      // backfill; `proceed` re-records the same values idempotently.
      await recordDeploymentGithubRepo(deployment.id, repo);
      resourceIds.githubRepo = repo.fullName;
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'github',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { repoFullName: repo.fullName },
      });
      const commitSha = await deps.pushFiles(
        repo.fullName,
        files,
        `Publish ${kind.toLowerCase()} ${slug}`,
        deployment.workspaceId,
        branch,
      );
      pushedCommitSha = commitSha;
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'github',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { repoFullName: repo.fullName, commitSha },
      });
    });

    await step('app', async () => {
      if (resourceIds.coolifyAppUuid) return;
      const created = await withProviderRetry(() =>
        deps.createApp(auth, {
          repoUrl: `https://github.com/${resourceIds.githubRepo || deployment.repoFullName}`,
          branch,
          domain: host,
          deployType: stack.deployType,
          buildCommand: stack.buildCommand,
          outputDir: stack.outputDir,
          startCommand: stack.startCommand,
          port: stack.port,
          dockerfile: stack.dockerfile,
          name: coolifyAppName(slug, kind),
          projectUuid: server.projectUuid,
          serverIp: server.serverIp,
        }),
      );
      resourceIds.coolifyAppUuid = created.uuid;
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'app',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { coolifyAppUuid: created.uuid },
      });
    });

    await step('dns', async () => {
      if (resourceIds.dnsRecordId) return;
      const dnsRecordId = await withProviderRetry(() =>
        deps.upsertDns(dnsLabel(slug, kind), server.serverIp),
      );
      resourceIds.dnsRecordId = dnsRecordId;
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'dns',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { dnsRecordId },
      });
    });

    await step('domain', async () => {
      const appUuid = resourceIds.coolifyAppUuid || deployment.coolifyAppUuid;
      if (!appUuid) throw new Error('Coolify app missing — publish again');
      // Every re-publish runs this step again (a fresh job starts with all steps pending),
      // so it merges instead of overwriting, then re-asserts the primary/alias 301s.
      // Overwriting used to strip every ACTIVE custom domain off the application.
      await deps.addAppDomain(auth, appUuid, host);
      await deps.applyRedirects(deployment.id);
    });

    let buildLogUrl = deployment.buildLogUrl;
    await step('deploy', async () => {
      const appUuid = resourceIds.coolifyAppUuid || deployment.coolifyAppUuid;
      if (!appUuid) throw new Error('Coolify app missing — publish again');
      // Coolify builds `git_commit_sha` when the application carries one, and a rollback
      // (F-264) deliberately leaves it carrying an older release. Without re-pinning, the
      // next publish would push a new commit and then rebuild the release the user had
      // just rejected — and report a successful publish. Pinning to the commit this job
      // pushed is also stricter than clearing the pin: it builds exactly what was
      // published, not whatever the branch head is by the time Coolify clones it.
      if (pushedCommitSha) {
        const pinned = await deps.pinCommit(auth, appUuid, pushedCommitSha);
        if (!pinned.ok) {
          throw new Error(
            `${pinned.error} Nothing was deployed, so the site is unchanged — try publishing again.`,
          );
        }
      }
      const triggered = await deps.startDeploy(auth, appUuid);
      buildLogUrl = `${server.apiUrl.replace(/\/+$/, '')}/application/${appUuid}`;
      // Onto `resourceIds`, not just `lastRequestId`: `poll` is a separate step, so a
      // resumed job has to find the deployment this job triggered rather than fall back
      // to whatever the application is currently serving.
      resourceIds.coolifyDeploymentUuid = triggered.deploymentUuid;
      await persistProgress(jobId, deployment.id, {
        steps,
        currentStep: 'deploy',
        resourceIds,
        hadSuccessfulDeployment,
        extra: { buildLogUrl, lastRequestId: triggered.deploymentUuid || job.requestId || null },
      });
    });

    await step('poll', async () => {
      const deploymentUuid = resourceIds.coolifyDeploymentUuid;
      // No uuid is a failure to verify, never a success. Reading the application instead
      // is what made every re-publish report LIVE on its first poll: the application was
      // already `running:healthy` from the previous build, so the loop broke immediately
      // and the job wrote LIVE + a fresh `publishedAt` while the new build was still
      // running — or after it had already failed.
      if (!deploymentUuid) {
        throw new Error(
          'Coolify did not return a deployment id, so this build could not be verified. Open the build log to check it.',
        );
      }
      const deadline = Date.now() + PUBLISH_POLL_TIMEOUT_MS;
      let lastHealth: DeploymentHealth = 'building';
      let lastStatus = 'queued';
      // Coolify answered but named no status. `getCoolifyDeployment` returns the sentinel
      // rather than reading the application's hostname list as a health string (F-218);
      // the poll must not read it as a queue state either, or a partial response costs
      // ten minutes and then blames a build Coolify never described.
      let unreported = 0;
      while (Date.now() < deadline) {
        const state = await deps.deploymentStatus(auth, deploymentUuid);
        if (state.status === COOLIFY_STATUS_UNREPORTED) {
          unreported += 1;
          if (unreported >= PUBLISH_UNREPORTED_STATUS_READS) {
            throw new Error(
              `Coolify did not report a status for this build after ${unreported} checks. Open the build log to see what it did.`,
            );
          }
          await sleep(PUBLISH_UNREPORTED_RETRY_MS);
          continue;
        }
        unreported = 0;
        lastHealth = state.health;
        lastStatus = state.status;
        if (state.health === 'healthy') break;
        if (state.health === 'failed') {
          throw new Error(`Coolify build fail: ${state.status}`);
        }
        await sleep(PUBLISH_POLL_MS);
      }
      if (lastHealth !== 'healthy') {
        throw new Error(
          `Coolify did not finish this build within 10 minutes (last reported "${lastStatus}")`,
        );
      }
    });

    await step('live', async () => {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'LIVE',
          progressStep: 'live',
          url: urlForSlug(slug, kind, root),
          publishedAt: new Date(),
          lastError: null,
          buildLogUrl,
        },
      });
      await prisma.project.update({
        where: { id: job.projectId },
        data: { status: kind === 'LIVE' ? 'published' : 'preview' },
      });
    });

    await succeedJob(jobId, { lastStep: 'live' });
    log.info('publish.job_succeeded', { jobId, projectId: job.projectId, kind });
    return getJob(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publish failed';
    await failJob(jobId, {
      errorCode: publishJobErrorCode(error),
      errorMessage: message,
    });
    await markDeploymentFailed(deployment.id, message, hadSuccessfulDeployment);
    throw error;
  } finally {
    heartbeat.stop();
  }
}
