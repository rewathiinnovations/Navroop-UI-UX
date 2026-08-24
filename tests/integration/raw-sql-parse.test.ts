import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * Every hand-written statement in `lib/**` pushed through the real Postgres parser.
 *
 * A syntax error in raw SQL is invisible to unit tests: a mocked Prisma resolves
 * whatever the mock is told to resolve, and `tsc` only sees a template literal. The
 * statement is only parsed when a real server receives it, so a placeholder sitting in
 * a position Postgres does not allow (`INTERVAL $1`, `SET $1`, an identifier) ships
 * silently and then fails on every call at runtime with `42601`.
 *
 * These cases therefore care about one thing: does Postgres *parse* the statement.
 * Arguments are deliberately bogus, so most statements match zero rows, and a foreign
 * key or not-found error is a pass — those prove the statement reached the planner.
 * Only a syntax error fails.
 */

const prisma = testPrismaClient();

const SYNTAX_ERROR = /syntax error|\b42601\b/i;

/**
 * Fails when Postgres could not parse the statement — and when the statement never
 * reached Postgres at all.
 *
 * The second half is not decoration. This helper only ever tested the message, so a probe
 * naming an export that does not exist threw `TypeError: x is not a function`, which fell
 * straight through the `catch` and reported a pass while covering nothing. Only an error
 * raised by the driver (`PrismaClient*`) is evidence that the planner saw the SQL.
 */
async function parses(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SYNTAX_ERROR.test(message)) {
      throw new Error(`Postgres rejected the statement: ${message}`);
    }
    if (!(error instanceof Error) || !error.name.startsWith('PrismaClient')) {
      throw new Error(`The statement was never sent: ${message}`);
    }
  }
}

const BOGUS = 'raw_sql_parse_missing_row';
const WS = 'ws_raw_sql_parse';

/** Two independent project trees, so the scoping join has something to exclude. */
const DOMAIN_WS = 'ws_raw_sql_parse_domains';
const DOMAIN_USER = 'user_raw_sql_parse_domains';
const DOMAIN_SERVER = 'srv_raw_sql_parse_domains';
const DOMAIN_KEYS = ['mine', 'theirs'] as const;
const domainProjectId = (key: string) => `proj_raw_sql_parse_${key}`;

/**
 * A project with its own Deployment and one CustomDomain hanging off it.
 *
 * `CustomDomain` carries no `projectId` — it reaches one only through `Deployment` — so
 * every row in the chain has to exist for the scoping join to be exercised at all.
 */
async function seedProjectWithDomain(key: (typeof DOMAIN_KEYS)[number]) {
  const projectId = domainProjectId(key);
  const hostname = `${key}.raw-sql-parse.test`;
  await prisma.workspace.upsert({
    where: { id: DOMAIN_WS },
    create: { id: DOMAIN_WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: DOMAIN_USER },
    create: {
      id: DOMAIN_USER,
      email: 'raw-sql-parse-domains@example.com',
      name: 'Domain Scope',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.coolifyServer.upsert({
    where: { id: DOMAIN_SERVER },
    create: {
      id: DOMAIN_SERVER,
      name: 'raw-sql-parse',
      apiUrl: 'https://coolify.example.test',
      apiToken: 'not-a-real-token',
      serverIp: '203.0.113.10',
      projectUuid: 'raw-sql-parse',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: `Domain scope ${key}`,
      ownerId: DOMAIN_USER,
      initialPrompt: 'domain scope probe',
    },
    update: {},
  });
  const deployment = await prisma.deployment.upsert({
    where: { projectId_kind: { projectId, kind: 'LIVE' } },
    create: {
      projectId,
      workspaceId: DOMAIN_WS,
      serverId: DOMAIN_SERVER,
      kind: 'LIVE',
      status: 'LIVE',
      slug: `raw-sql-parse-${key}`,
      publishedById: DOMAIN_USER,
    },
    update: {},
  });
  const domain = await prisma.customDomain.upsert({
    where: { hostname },
    create: {
      deploymentId: deployment.id,
      workspaceId: DOMAIN_WS,
      hostname,
      verifyToken: `tok_${key}`,
      expectedTarget: '203.0.113.10',
    },
    update: { deploymentId: deployment.id },
  });
  return { projectId, deploymentId: deployment.id, domainId: domain.id, hostname };
}

afterAll(async () => {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "AppSetting" WHERE key = 'sandbox.roundRobinCursor'`.catch(
    () => undefined,
  );
  const domainProjects = DOMAIN_KEYS.map(domainProjectId);
  await prisma.customDomain
    .deleteMany({ where: { workspaceId: DOMAIN_WS } })
    .catch(() => undefined);
  await prisma.deployment
    .deleteMany({ where: { projectId: { in: domainProjects } } })
    .catch(() => undefined);
  await prisma.coolifyServer.deleteMany({ where: { id: DOMAIN_SERVER } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: { in: domainProjects } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: DOMAIN_USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${DOMAIN_WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('lib raw SQL parses on Postgres', () => {
  it('project lock statements', async () => {
    const { acquireLock, bumpContentVersion, releaseLock, renewLock } =
      await import('@/lib/projects/lock');
    await parses(() => acquireLock(BOGUS, BOGUS, 'generation'));
    await parses(() => renewLock(BOGUS, BOGUS));
    await parses(() => releaseLock(BOGUS, BOGUS));
    await parses(() => bumpContentVersion(BOGUS));
  });

  it('presence statements', async () => {
    const { getProjectLockState, heartbeatPresence, listRecentPresence, pruneStalePresence } =
      await import('@/lib/projects/presence');
    await parses(() => listRecentPresence(BOGUS));
    await parses(() => getProjectLockState(BOGUS));
    await parses(() => heartbeatPresence(BOGUS, BOGUS));
    await parses(() => pruneStalePresence());
  });

  it('plan approval compensation', async () => {
    const { revertApprovedPlan } = await import('@/lib/projects/plan-compensate');
    await parses(() => revertApprovedPlan({ projectId: BOGUS, planId: BOGUS }));
  });

  it('job store statements', async () => {
    const store = await import('@/lib/jobs/store');
    await parses(() => store.getJob(BOGUS));
    await parses(() => store.getActiveJob(BOGUS));
    await parses(() => store.findJobByIdempotency(BOGUS, BOGUS));
    await parses(() => store.updateJobFields(BOGUS, { heartbeatAt: new Date() }));
    await parses(() => store.updateJobIfActive(BOGUS, { status: 'ABANDONED' }));
    await parses(() => store.setProjectActiveJob(BOGUS, null));
    await parses(() => store.setProjectResumablePhase(BOGUS, 'COMPLETE'));
    await parses(() => store.claimJobCreditCharge(BOGUS, new Date()));
    await parses(() => store.releaseJobCreditCharge(BOGUS, new Date()));
    await parses(() => store.settleKeptPartialJob(BOGUS));
    await parses(() => store.listReconcileCandidates(new Date(), new Date()));
    await parses(() => store.listTimeoutCandidates(new Date()));
    await parses(() => store.listLegacyStuckProjects());
  });

  it('SSRF private-reject counter', async () => {
    const { incrementPrivateReject } = await import('@/lib/security/reject-log');
    await parses(() => incrementPrivateReject(BOGUS));
  });

  it('workspace spend accrual, including the 80% and auto-pause claims', async () => {
    const { accrueSpend, readWorkspaceSpend } = await import('@/lib/plans/spend');
    await parses(() => readWorkspaceSpend(BOGUS));
    // A real row, so the alert-claim and auto-pause statements are reached rather than
    // short-circuited by the missing-workspace guard.
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`;
    await prisma.$executeRaw`
      INSERT INTO "Workspace" (
        id, "storageBytes", "creditsUsed", "creditsPeriodStart",
        "generationPaused", "spendUsd", "spendAlert80Sent",
        "monthlySpendLimitUsd"
      ) VALUES (${WS}, 0, 0, NOW(), false, 0, false, 1)
    `;
    await parses(() => accrueSpend(WS, 0.85));
    await parses(() => accrueSpend(WS, 0.5));
    // Second crossing takes the already-paused branch.
    await parses(() => accrueSpend(WS, 0.5));
  });

  it('credit consumption and the 80% claim', async () => {
    const { consumeCredits } = await import('@/lib/plans/limits');
    // A default plan, for the same reason the test above seeds a workspace: without one
    // the statements are never reached.
    //
    // `consumeCredits` resolves the effective plan before it issues any SQL, and
    // `getEffectivePlan` throws a plain `Error('No default plan is configured')` when no
    // row is marked default. That is not a `PrismaClient*` error, so `parses` reports
    // "the statement was never sent" — correctly, and the assertion then says nothing
    // about the SQL it exists to check. A developer database that happens to hold a
    // seeded plan hides this; CI's fresh one does not, which is where it surfaced.
    //
    // Removed again in `finally`: `isDefault` is global, so a plan left behind would
    // change what every other suite sharing this database reads back from
    // `getEffectivePlan`.
    const planId = `plan_${BOGUS}`;
    // Deleted first, so a run that crashed before its finally cannot collide on the key.
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.plan.create({
      data: {
        id: planId,
        key: `key_${BOGUS}`,
        name: 'Raw SQL parse probe',
        isDefault: true,
        monthlyCredits: 1,
        maxProjects: 1,
        maxLiveSites: 1,
        maxPreviewSites: 1,
        maxMembers: 1,
        checkpointRetentionDays: 1,
        storageBytesLimit: BigInt(1),
      },
    });
    try {
      await parses(() => consumeCredits(BOGUS, BOGUS, 'generation'));
      await parses(() => consumeCredits(WS, BOGUS, 'generation'));
    } finally {
      await prisma.plan.deleteMany({ where: { id: planId } });
    }
  });

  it('credit period roll', async () => {
    const { rollCreditPeriodIfNeeded } = await import('@/lib/plans/limits');
    await prisma.$executeRaw`
      UPDATE "Workspace" SET "creditsPeriodStart" = NOW() - INTERVAL '2 months' WHERE id = ${WS}
    `;
    await parses(() => rollCreditPeriodIfNeeded(WS));
  });

  it('audit log statements', async () => {
    const { persistAuditRow, pruneAuditLogs } = await import('@/lib/audit/log');
    await parses(() =>
      persistAuditRow({
        id: `aud_${BOGUS}`,
        workspaceId: null,
        actorId: null,
        actorEmail: 'nobody@example.com',
        action: 'raw_sql.parse_probe',
        targetType: null,
        targetId: null,
        before: null,
        after: null,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    );
    await parses(() => pruneAuditLogs());
    const { listAuditLogs } = await import('@/lib/audit/admin');
    await parses(() => listAuditLogs({ actor: 'nobody', action: 'raw_sql.parse_probe' }));
  });

  it('onboarding and terms statements', async () => {
    const onboarding = await import('@/lib/onboarding/preferences');
    await parses(() => onboarding.getOnboardingPreferences(BOGUS));
    await parses(() => onboarding.dismissPromptTips(BOGUS));
    await parses(() => onboarding.completeProductTour(BOGUS));
    const legal = await import('@/lib/legal/register');
    await parses(() => legal.acceptTermsForUser(BOGUS));
    await parses(() => legal.getTermsStatus(BOGUS));
  });

  it('preview build statements', async () => {
    const db = await import('@/lib/preview/db');
    await parses(() => db.getProjectPreviewFields(BOGUS));
    await parses(() =>
      db.setProjectPreviewFields(BOGUS, { previewMode: 'STATIC', activePreviewBuildId: null }),
    );
  });

  it('custom domain statements', async () => {
    const store = await import('@/lib/domains/store');
    await parses(() => store.findPrimaryForDeployment(BOGUS));
    await parses(() => store.mapPrimaryHosts([BOGUS]));
    await parses(() => store.clearPrimaryForDeployment(BOGUS));
    await parses(() => store.clearPrimaryForDeployment(BOGUS, BOGUS));
    await parses(() => store.deleteCustomDomainRow(BOGUS));
    // The two project-scoped statements are deliberately *not* wrapped in `parses`: they
    // are the only ones here that alias and join, and the mistake to catch is a wrong
    // alias or a mis-quoted identifier, which Postgres reports as 42703/42P01 rather
    // than 42601 — `parses` would swallow exactly the class of error they invite.
    expect(await store.findCustomDomainForProject(BOGUS, BOGUS)).toBeNull();
    expect(await store.listCustomDomainsForProject(BOGUS)).toEqual([]);
  });

  /**
   * The project-scoped join, on rows.
   *
   * `findCustomDomainForProject` / `listCustomDomainsForProject` *are* the domain IDOR
   * fix: a lookup by domain id alone let any project owner delete, re-point, re-verify or
   * email the DNS instructions (verify token included) of another project's domain. The
   * behavioural suite for them replaces `$queryRaw` with an interpreter that branches on
   * two substrings, so the SQL itself never reaches Postgres there. Zero-row calls above
   * prove the statement is legal; only real rows prove the join predicate and the bind
   * order — reversed binds (`d.id = $projectId AND p.projectId = $id`) parse perfectly and
   * return nothing, which reads as "not found" and 404s every real domain mutation.
   */
  it('the project-scoped domain join selects by project and refuses another project', async () => {
    const domains = await import('@/lib/domains/store');
    const mine = await seedProjectWithDomain('mine');
    const theirs = await seedProjectWithDomain('theirs');

    const listed = await domains.listCustomDomainsForProject(mine.projectId);
    expect(listed.map((row) => row.id)).toEqual([mine.domainId]);
    expect(listed[0]?.hostname).toBe(mine.hostname);
    expect(listed[0]?.deploymentId).toBe(mine.deploymentId);
    // `SELECT d.*`, not `SELECT *`: an unqualified star returns "id" from both tables and
    // the driver keeps the later one, so `mapRow` would hand callers the Deployment id as
    // the domain id — and every subsequent delete/re-point would address the wrong row.
    expect(listed[0]?.id).not.toBe(mine.deploymentId);

    const found = await domains.findCustomDomainForProject(mine.projectId, mine.domainId);
    expect(found?.id).toBe(mine.domainId);
    expect(found?.hostname).toBe(mine.hostname);

    // The IDOR itself: the other project's owner authorises against their own project id.
    expect(await domains.findCustomDomainForProject(theirs.projectId, mine.domainId)).toBeNull();
    expect(
      (await domains.listCustomDomainsForProject(theirs.projectId)).map((row) => row.id),
    ).toEqual([theirs.domainId]);
    // A domain id that exists nowhere, so a missing `d."id"` predicate cannot pass.
    expect(await domains.findCustomDomainForProject(mine.projectId, BOGUS)).toBeNull();
  });

  it('an aliasing mistake in that join is rejected, not silently empty', async () => {
    // The negative control for the two cases above. Their whole value rests on Postgres
    // refusing a scoping predicate that does not resolve; if a mistake merely returned
    // zero rows the cases would be indistinguishable from the mocked interpreter they
    // exist to backstop. Both variants below differ from the real statement in exactly
    // one way a real mistake would, and the real statements are never re-typed here —
    // they are imported and executed as themselves, so this cannot drift into passing
    // while production breaks.
    const wrongAlias = prisma.$queryRawUnsafe(
      // `p` renamed on one side only.
      'SELECT d.* FROM "CustomDomain" d INNER JOIN "Deployment" dep ON dep."id" = d."deploymentId" WHERE d."id" = $1 AND p."projectId" = $2 LIMIT 1',
      BOGUS,
      BOGUS,
    );
    await expect(wrongAlias).rejects.toThrow(/missing FROM-clause entry|42P01|42703/i);

    const wrongTable = prisma.$queryRawUnsafe(
      // The scope read off the domain row instead of through the join — the mistake the
      // whole join exists to avoid, since "CustomDomain" has no "projectId" column.
      'SELECT d.* FROM "CustomDomain" d WHERE d."id" = $1 AND d."projectId" = $2 LIMIT 1',
      BOGUS,
      BOGUS,
    );
    await expect(wrongTable).rejects.toThrow(/column d\.\"?projectId|42703/i);
  });

  it('backup run statements', async () => {
    const runs = await import('@/lib/backup/runs');
    await parses(() => runs.listBackupRuns(5));
    const started = await runs.startBackupRun('db');
    await parses(() =>
      runs.finishBackupRun({
        id: started.id,
        status: 'succeeded',
        objectKey: 'probe',
        sizeBytes: 1,
        detail: null,
        startedAt: started.startedAt,
      }),
    );
    await prisma.$executeRaw`DELETE FROM "BackupRun" WHERE id = ${started.id}`;
  });

  it('template statements', async () => {
    // `tests/**` is excluded from tsconfig, so a probe naming an export that does not
    // exist type-checks. `parses` now fails on a TypeError rather than reporting a pass,
    // which is how the wrong names here were found.
    const store = await import('@/lib/templates/store');
    await parses(() => store.listTemplateRows({ workspaceId: WS }));
    await parses(() => store.findTemplateById(BOGUS));
    await parses(() => store.findTemplateBySlug(BOGUS));
    await parses(() => store.deleteTemplateRow(BOGUS));
    const usage = await import('@/lib/templates/usage');
    await parses(() => usage.incrementUsageCount(BOGUS));
  });

  it('project list fallback, every filter and sort combination', async () => {
    // The fallback only runs when the Prisma client is stale, so a placeholder numbered
    // wrong here would sit latent. Each combination shifts the numbering.
    const { buildProjectListQuery } = await import('@/lib/projects/list-sql');
    for (const mine of [undefined, true, false]) {
      for (const starred of [false, true]) {
        for (const search of [undefined, 'cafe']) {
          for (const sort of ['updatedAt', 'name', 'createdAt']) {
            const { sql, values } = buildProjectListQuery({
              userId: BOGUS,
              sort,
              search,
              mine,
              starred,
            });
            expect(sql).not.toMatch(/\$\{/);
            await parses(() => prisma.$queryRawUnsafe(sql, ...values));
          }
        }
      }
    }
  });

  it('admin audit log list, every filter combination', async () => {
    const { listAuditLogs } = await import('@/lib/audit/admin');
    for (const actor of [undefined, 'someone@example.com']) {
      for (const action of [undefined, 'project.create']) {
        for (const from of [undefined, '2026-01-01']) {
          for (const to of [undefined, '2026-12-31']) {
            await parses(() => listAuditLogs({ actor, action, from, to, take: 1 }));
          }
        }
      }
    }
  });

  it('project search statements', async () => {
    const { searchProjects } = await import('@/lib/search/projects');
    await parses(() => searchProjects({ q: 'cafe' }));
  });

  it('observability statements', async () => {
    const { createPrismaObservabilityStore } = await import('@/lib/observability/store');
    const store = createPrismaObservabilityStore(prisma);
    const createdAt = new Date();
    // These now execute for real: openlovable_test was two migrations behind, so the
    // tables did not exist and every statement here stopped at 42P01 without ever
    // reaching the planner. Asserting on the rows written proves the SQL round-trips.
    await store.createCheck({
      kind: 'raw_sql_probe',
      ok: true,
      detail: null,
      eventId: null,
      createdAt,
    });
    const checks = await store.listChecks('raw_sql_probe');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]?.kind).toBe('raw_sql_probe');
    expect(await store.listChecks()).not.toHaveLength(0);

    await store.createCronRun({
      name: 'raw_sql_probe',
      ok: true,
      durationMs: 1,
      detail: null,
      createdAt,
    });
    const runs = await store.listCronRuns('raw_sql_probe');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.name).toBe('raw_sql_probe');
    // DISTINCT ON is what /admin/health and the digest read now. It replaced an unfiltered
    // `LIMIT 400` over every cron name, and a fake store cannot prove the statement parses.
    const latest = await store.listLatestCronRunPerName();
    expect(latest.some((row) => row.name === 'raw_sql_probe')).toBe(true);
    expect(latest.filter((row) => row.name === 'raw_sql_probe')).toHaveLength(1);

    // Two retention deletes, each with a DISTINCT ON subquery inside NOT IN. Dynamic import
    // matches every other probe in this file: a module that fails to load must fail one case,
    // not the whole file. The cutoff is pushed back to 1970 so the statements parse and plan
    // against a real server without deleting another suite's fixtures.
    const { pruneObservabilityHistory } = await import('@/lib/observability/prune');
    await parses(() => pruneObservabilityHistory(new Date('1971-01-01T00:00:00.000Z')));

    await prisma.$executeRaw`DELETE FROM "ObservabilityCheck" WHERE kind = 'raw_sql_probe'`;
    await prisma.$executeRaw`DELETE FROM "CronRun" WHERE name = 'raw_sql_probe'`;
  });

  // No plan-cap probe. `getPlanCaps` used to run a hand-written SELECT; the caps are
  // ordinary NOT NULL columns since `20260817260000_consumption_caps`, so it reads them
  // off the Plan row through the generated client and there is no statement left to parse.
  // A probe on it would report a pass while covering nothing — do not add one back.

  it('the probe itself rejects a genuinely broken statement', async () => {
    // Without this the suite could pass by never detecting anything. `INTERVAL $1` is
    // the exact shape Postgres refuses: a placeholder where a literal must be.
    const days = 1;
    await expect(
      parses(
        () =>
          prisma.$executeRaw`DELETE FROM "CronRun" WHERE "createdAt" < NOW() - INTERVAL ${days}`,
      ),
    ).rejects.toThrow(/Postgres rejected the statement/);
  });

  it('the probe rejects a statement that was never sent', async () => {
    // The other way this suite could pass by covering nothing: a probe that names an
    // export which no longer exists. `getProjectLock` was exactly that — no such export
    // has ever been in lib/projects/lock.ts — and the resulting TypeError fell through
    // the catch as a pass. A JS failure is not a parse result.
    const missing = (undefined as unknown as { gone: () => Promise<unknown> } | undefined)?.gone;
    await expect(parses(() => missing!())).rejects.toThrow(/statement was never sent/);
  });
});
