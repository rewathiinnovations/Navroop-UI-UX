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

/** Fails only when Postgres could not parse the statement. */
async function parses(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SYNTAX_ERROR.test(message)) {
      throw new Error(`Postgres rejected the statement: ${message}`);
    }
  }
}

const BOGUS = 'raw_sql_parse_missing_row';
const WS = 'ws_raw_sql_parse';

afterAll(async () => {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "AppSetting" WHERE key = 'sandbox.roundRobinCursor'`.catch(
    () => undefined,
  );
  await prisma.$disconnect();
});

describe('lib raw SQL parses on Postgres', () => {
  it('project lock statements', async () => {
    const { acquireLock, bumpContentVersion, getProjectLock, releaseLock, renewLock } = await import(
      '@/lib/projects/lock'
    );
    await parses(() => getProjectLock(BOGUS));
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
    await parses(() => store.listReconcileCandidates(new Date()));
    await parses(() => store.listTimeoutCandidates(new Date()));
    await parses(() => store.listLegacyStuckProjects());
  });

  it('SSRF private-reject counter', async () => {
    const { incrementPrivateReject } = await import('@/lib/security/reject-log');
    await parses(() => incrementPrivateReject(BOGUS));
  });

  it('round-robin provider cursor', async () => {
    const { selectProvider } = await import('@/lib/sandbox/router');
    await parses(() => selectProvider({ strategy: 'round_robin', candidates: [] }));
  });

  it('sandbox minute meter', async () => {
    const meter = await import('@/lib/sandbox/meter');
    await parses(() => meter.readSandboxMinutesUsed(BOGUS));
    await parses(() => meter.readMonthlySandboxMinutes(BOGUS));
    await parses(() => meter.accrueSandboxMinutes(BOGUS, 3));
  });

  it('sandbox provider config store', async () => {
    const store = await import('@/lib/sandbox/store');
    await parses(() => store.listProviderConfigs());
    await parses(() => store.getRoutingStrategy());
    await parses(() => store.updateProviderConfig(BOGUS, { healthStatus: 'unknown' }));
    await parses(() => store.deleteProviderConfig(BOGUS));
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
        "generationPaused", "sandboxMinutesUsed", "spendUsd", "spendAlert80Sent",
        "monthlySpendLimitUsd"
      ) VALUES (${WS}, 0, 0, NOW(), false, 0, 0, false, 1)
    `;
    await parses(() => accrueSpend(WS, 0.85));
    await parses(() => accrueSpend(WS, 0.5));
    // Second crossing takes the already-paused branch.
    await parses(() => accrueSpend(WS, 0.5));
  });

  it('credit consumption and the 80% claim', async () => {
    const { consumeCredits } = await import('@/lib/plans/limits');
    await parses(() => consumeCredits(BOGUS, BOGUS, 'generation'));
    await parses(() => consumeCredits(WS, BOGUS, 'generation'));
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
    await parses(() => db.setProjectPreviewFields(BOGUS, { previewMode: 'STATIC', activePreviewBuildId: null }));
  });

  it('custom domain statements', async () => {
    const store = await import('@/lib/domains/store');
    await parses(() => store.findPrimaryForDeployment(BOGUS));
    await parses(() => store.mapPrimaryHosts([BOGUS]));
    await parses(() => store.clearPrimaryForDeployment(BOGUS));
    await parses(() => store.clearPrimaryForDeployment(BOGUS, BOGUS));
    await parses(() => store.deleteCustomDomainRow(BOGUS));
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
    const store = await import('@/lib/templates/store');
    await parses(() => store.listTemplateRows({ workspaceId: null }));
    await parses(() => store.findTemplateRow(BOGUS));
    await parses(() => store.deleteTemplateRow(BOGUS));
    const usage = await import('@/lib/templates/usage');
    await parses(() => usage.readTemplateUsage(BOGUS));
  });

  it('project list fallback, every filter and sort combination', async () => {
    // The fallback only runs when the Prisma client is stale, so a placeholder numbered
    // wrong here would sit latent. Each combination shifts the numbering.
    const { buildProjectListQuery } = await import('@/lib/projects/list-sql');
    for (const mine of [undefined, true, false]) {
      for (const starred of [false, true]) {
        for (const search of [undefined, 'cafe']) {
          for (const sort of ['updatedAt', 'name', 'createdAt']) {
            const { sql, values } = buildProjectListQuery({ userId: BOGUS, sort, search, mine, starred });
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
    await parses(() => searchProjects({ query: 'cafe', userId: BOGUS }));
  });

  it('observability statements', async () => {
    const { createPrismaObservabilityStore } = await import('@/lib/observability/store');
    const store = createPrismaObservabilityStore(prisma);
    const createdAt = new Date();
    // These now execute for real: openlovable_test was two migrations behind, so the
    // tables did not exist and every statement here stopped at 42P01 without ever
    // reaching the planner. Asserting on the rows written proves the SQL round-trips.
    await store.createCheck({ kind: 'raw_sql_probe', ok: true, detail: null, eventId: null, createdAt });
    const checks = await store.listChecks('raw_sql_probe');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]?.kind).toBe('raw_sql_probe');
    expect(await store.listChecks()).not.toHaveLength(0);

    await store.createCronRun({ name: 'raw_sql_probe', ok: true, durationMs: 1, detail: null, createdAt });
    const runs = await store.listCronRuns('raw_sql_probe');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.name).toBe('raw_sql_probe');
    expect(await store.listCronRuns()).not.toHaveLength(0);

    await prisma.$executeRaw`DELETE FROM "ObservabilityCheck" WHERE kind = 'raw_sql_probe'`;
    await prisma.$executeRaw`DELETE FROM "CronRun" WHERE name = 'raw_sql_probe'`;
  });

  it('plan cap statements', async () => {
    const { readPlanCaps } = await import('@/lib/consumption/plan-caps');
    await parses(() => readPlanCaps(BOGUS));
  });

  it('the probe itself rejects a genuinely broken statement', async () => {
    // Without this the suite could pass by never detecting anything. `INTERVAL $1` is
    // the exact shape Postgres refuses: a placeholder where a literal must be.
    const days = 1;
    await expect(
      parses(() => prisma.$executeRaw`DELETE FROM "CronRun" WHERE "createdAt" < NOW() - INTERVAL ${days}`),
    ).rejects.toThrow(/Postgres rejected the statement/);
  });
});
