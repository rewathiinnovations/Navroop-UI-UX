import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { DEEPSEEK_PER_MILLION } from '@/lib/consumption/cost';
import { recordJobUsage } from '@/lib/consumption/record';
import { insertJobRaw } from '@/lib/jobs/store';

/**
 * What a generation cost has to reach the job row and the workspace spend, and
 * on the failure path it reached neither.
 *
 * The route recorded `await result?.usage` — the main stream only — so the
 * corrective ask and every truncation recovery cost money and reported none.
 * When the stream threw, `inputTokens` stayed 0 and `outputTokens` stayed
 * undefined; `recordJobUsage` priced that at $0 and `accrueSpend` was skipped
 * outright, so `Workspace.spendUsd` — the auto-pause ceiling — never saw the
 * failure (F-027). Compounding it, `ratesFor('deepseek', …)` matched no branch
 * in the rate table and fell through to an OpenAI mini-model rate of 0.15/0.60
 * per million (F-029).
 *
 * These assertions are about the rows, so they fail if either regresses.
 */

const prisma = testPrismaClient();

const USER = 'user_job_usage';
const WS = 'ws_job_usage';
const PROJECT = 'proj_job_usage';

const MILLION = 1_000_000;

async function seed() {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.$executeRaw`UPDATE "Workspace" SET "spendUsd" = 0, "monthlySpendLimitUsd" = NULL, "spendAlert80Sent" = false, "generationPaused" = false, "pauseReason" = NULL WHERE id = ${WS}`;
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'job-usage@example.com',
      name: 'Job usage',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'Job usage', ownerId: USER, initialPrompt: 'usage probe' },
    update: {},
  });
}

async function runningJob() {
  return insertJobRaw({
    projectId: PROJECT,
    workspaceId: WS,
    userId: USER,
    kind: 'BUILD',
    status: 'RUNNING',
    inputPrompt: 'usage probe',
  });
}

async function jobUsage(jobId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ tokensIn: number | null; tokensOut: number | null; estimatedCostUsd: unknown }>
  >`SELECT "tokensIn", "tokensOut", "estimatedCostUsd" FROM "GenerationJob" WHERE id = ${jobId}`;
  const row = rows[0];
  return {
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
  };
}

async function workspaceSpend() {
  const rows = await prisma.$queryRaw<
    Array<{ spendUsd: unknown }>
  >`SELECT "spendUsd" FROM "Workspace" WHERE id = ${WS}`;
  return Number(rows[0].spendUsd ?? 0);
}

/**
 * `Workspace.spendUsd` is `Decimal(12, 4)` while `Job.estimatedCostUsd` is
 * `Decimal(12, 6)`, so an accrual lands rounded to four places. At DeepSeek
 * rates a generation costs fractions of a cent, and this is where those places
 * go — worth pinning rather than hiding behind a loose tolerance.
 */
const asAccrued = (usd: number) => Math.round(usd * 10_000) / 10_000;

beforeEach(async () => {
  await seed();
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('a generation records what it spent', () => {
  it('prices a DeepSeek job at the DeepSeek rate and accrues it against the spend ceiling', async () => {
    const job = await runningJob();

    const cost = await recordJobUsage({
      jobId: job.id,
      workspaceId: WS,
      tokensIn: MILLION,
      tokensOut: MILLION,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    const expected = DEEPSEEK_PER_MILLION.flash.input + DEEPSEEK_PER_MILLION.flash.output;
    expect(cost).toBe(expected);
    // The number the spend ceiling used to run on.
    expect(cost).not.toBe(0.15 + 0.6);

    const usage = await jobUsage(job.id);
    expect(usage.tokensIn).toBe(MILLION);
    expect(usage.tokensOut).toBe(MILLION);
    expect(usage.estimatedCostUsd).toBe(expected);
    expect(await workspaceSpend()).toBe(asAccrued(expected));
  });

  it('records the sum of the main stream and the corrective ask, not just the first call', async () => {
    const job = await runningJob();

    // What the route now hands over: `RunUsage.totals` across both calls.
    const main = { tokensIn: 1200, tokensOut: 400 };
    const corrective = { tokensIn: 1800, tokensOut: 900 };

    const cost = await recordJobUsage({
      jobId: job.id,
      workspaceId: WS,
      tokensIn: main.tokensIn + corrective.tokensIn,
      tokensOut: main.tokensOut + corrective.tokensOut,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    const mainOnly =
      (main.tokensIn * DEEPSEEK_PER_MILLION.flash.input +
        main.tokensOut * DEEPSEEK_PER_MILLION.flash.output) /
      MILLION;

    const usage = await jobUsage(job.id);
    expect(usage.tokensIn).toBe(3000);
    expect(usage.tokensOut).toBe(1300);
    expect(cost).toBeGreaterThan(mainOnly);
    expect(await workspaceSpend()).toBe(asAccrued(cost));
  });

  it('records what a failed run burned instead of zero, so the ceiling still moves', async () => {
    const job = await runningJob();

    // The provider took the prompt and then failed: input estimated, no output.
    const cost = await recordJobUsage({
      jobId: job.id,
      workspaceId: WS,
      tokensIn: 24_000,
      tokensOut: 0,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    expect(cost).toBeGreaterThan(0);
    const usage = await jobUsage(job.id);
    expect(usage.tokensIn).toBe(24_000);
    expect(usage.estimatedCostUsd).toBe(cost);
    // `accrueSpend` is skipped only at exactly zero, which is what a failed run
    // used to report.
    expect(await workspaceSpend()).toBe(asAccrued(cost));
    expect(await workspaceSpend()).toBeGreaterThan(0);
  });

  it('still prices a provider the table does not know, rather than booking it as free', async () => {
    const job = await runningJob();

    const cost = await recordJobUsage({
      jobId: job.id,
      workspaceId: WS,
      tokensIn: MILLION,
      tokensOut: 0,
      provider: 'some-other-vendor',
      model: 'mystery-1',
    });

    expect(cost).toBe(DEEPSEEK_PER_MILLION.flash.input);
    expect(await workspaceSpend()).toBe(asAccrued(cost));
  });
});
