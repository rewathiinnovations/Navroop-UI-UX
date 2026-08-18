/**
 * Consumption caps, sandbox minutes, provider failover/queue, spend ceiling.
 * Run: npx tsx tests/consumption.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import {
  JOB_CAP_MESSAGE,
  JobCapError,
  JobCapTracker,
  LOOP_DETECTED_MESSAGE,
} from '../lib/consumption/caps.ts';
import { calculateEventCost, estimateTokenCostUsd } from '../lib/consumption/cost.ts';
import {
  SANDBOX_MINUTES_EXHAUSTED,
  canColdStartSandbox,
  sandboxMinutesBetween,
} from '../lib/sandbox/minutes.ts';
import { loadProviderChain } from '../lib/ai/providers.ts';
import { shouldFailover } from '../lib/ai/failover.ts';
import { createCircuitBreaker } from '../lib/ai/circuit.ts';
import { createProviderQueue, queuePositionLabel } from '../lib/ai/queue.ts';
import { executeWithFailover } from '../lib/ai/run.ts';
import {
  PAUSE_REASON_AUTOMATIC,
  PAUSE_REASON_MANUAL,
  pauseReasonLabel,
  shouldAutoPauseSpend,
  shouldNotifySpend80,
} from '../lib/plans/spend.ts';
import { accrueSandboxMinutes, checkSandboxMinutes } from '../lib/sandbox/meter.ts';
import { accrueSpend } from '../lib/plans/spend.ts';
import { getProviderHealth } from '../lib/ai/circuit.ts';
import { hashPassword } from '../lib/password.ts';
import { ensureDefaultPlan } from './factories/plan.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

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

function httpError(status: number, message = `HTTP ${status}`) {
  const error = new Error(message) as Error & { status?: number; statusCode?: number };
  error.status = status;
  error.statusCode = status;
  return error;
}

// --- Part A: stream caps + loop ---

const tiny = new JobCapTracker({
  maxTokensPerJob: 20,
  maxFilesPerJob: 2,
  maxOutputBytesPerJob: 80,
});

const first = tiny.addChunk('hello world this is a file start ');
assert(first === null, 'small first chunk stays under token/byte caps');

tiny.addFile('src/App.tsx', 'export default function App() { return null }');
const secondFile = tiny.addFile('src/page.tsx', 'export default function Page() { return null }');
assert(secondFile === null, 'two distinct files stay under file cap');

const overflow = tiny.addChunk('x'.repeat(200));
assert(overflow instanceof JobCapError, 'token/byte overflow aborts mid-stream');
assert(overflow?.errorCode === 'job_cap_exceeded', 'overflow errorCode is job_cap_exceeded');
assert(overflow?.message === JOB_CAP_MESSAGE, 'overflow English: This build got too large — try a shorter prompt');
assert(tiny.partialFiles.length === 2, 'partial files are kept after cap abort');
assert(tiny.partialFiles.some((file) => file.path === 'src/App.tsx'), 'first partial file preserved');

const filesCap = new JobCapTracker({ maxTokensPerJob: 100000, maxFilesPerJob: 1, maxOutputBytesPerJob: 2000000 });
filesCap.addFile('a.tsx', 'one');
const thirdFile = filesCap.addFile('b.tsx', 'two');
assert(thirdFile instanceof JobCapError && thirdFile.errorCode === 'job_cap_exceeded', 'file cap aborts on extra file');
assert(filesCap.partialFiles.length === 1, 'file-cap abort keeps the files already written');

const loop = new JobCapTracker({ maxTokensPerJob: 100000, maxFilesPerJob: 60, maxOutputBytesPerJob: 2000000 });
assert(loop.addFile('src/App.tsx', 'v1') === null, 'first write of a path is allowed');
assert(loop.addFile('src/App.tsx', 'v2') === null, 'second write of a path is allowed');
assert(loop.addFile('src/App.tsx', 'v3') === null, 'third write of a path is allowed');
const looped = loop.addFile('src/App.tsx', 'v4');
assert(looped instanceof JobCapError, 'fourth write of the same path aborts');
assert(looped?.errorCode === 'loop_detected', 'loop errorCode is loop_detected');
assert(looped?.message === LOOP_DETECTED_MESSAGE, 'loop English message names the cause');

const tokenCost = estimateTokenCostUsd({ tokensIn: 1000, tokensOut: 4000, provider: 'openai', model: 'gpt-4o-mini' });
const cheap = estimateTokenCostUsd({ tokensIn: 10, tokensOut: 10, provider: 'openai', model: 'gpt-4o-mini' });
assert(tokenCost > cheap, 'token-based cost scales with tokens, not a flat event constant');
assert(tokenCost > 0, 'token cost is positive');
const withTokens = calculateEventCost('initial', false, { tokensIn: 2000, tokensOut: 8000, provider: 'groq', model: 'kimi' });
const flat = calculateEventCost('initial', false);
assert(withTokens !== flat, 'usage tracking uses token cost when tokens are present');

// --- Part B: sandbox minute math ---

const started = new Date('2026-08-17T12:00:00.000Z');
assert(sandboxMinutesBetween(started, new Date('2026-08-17T12:00:00.000Z')) === 0, 'zero elapsed is 0 minutes');
assert(sandboxMinutesBetween(started, new Date('2026-08-17T12:00:30.000Z')) === 1, '30s wall-clock ceils to 1 minute');
assert(sandboxMinutesBetween(started, new Date('2026-08-17T12:07:00.000Z')) === 7, '7 minutes matches wall-clock');
assert(sandboxMinutesBetween(started, new Date('2026-08-17T12:07:01.000Z')) === 8, '7m1s ceils to 8 minutes');
assert(canColdStartSandbox(299, 300) === true, 'one minute remaining allows a cold start');
assert(canColdStartSandbox(300, 300) === false, 'exhausted minutes refuse a cold start');
assert(canColdStartSandbox(301, 300) === false, 'over-limit minutes refuse a cold start');
assert(SANDBOX_MINUTES_EXHAUSTED === "This month's sandbox time is used up", 'cold-start English message');

// --- Part C: failover / queue / circuit ---

const chain = loadProviderChain({
  AI_PRIMARY_PROVIDER: 'groq',
  AI_PRIMARY_MODEL: 'moonshotai/kimi-k2-instruct-0905',
  AI_FALLBACK_PROVIDER: 'openai',
  AI_FALLBACK_MODEL: 'gpt-4o-mini',
  GROQ_API_KEY: 'test-groq',
  OPENAI_API_KEY: 'test-openai',
});
assert(chain.length >= 2, 'provider chain has primary + fallback');
assert(chain[0]?.provider === 'groq' && chain[1]?.provider === 'openai', 'primary and fallback are different vendors');
assert(!chain.some((entry) => /sk-|gsk_/.test(JSON.stringify(entry.apiKeyEnv))), 'chain stores env key names, not raw secrets');

assert(shouldFailover(httpError(503)) === true, '503 is a failover trigger');
assert(shouldFailover(httpError(529)) === true, '529 overload is a failover trigger');
assert(shouldFailover(new Error('connect ECONNREFUSED')) === true, 'connection errors failover');
assert(shouldFailover(httpError(400)) === false, '4xx does not failover');
assert(shouldFailover(httpError(403, 'content filter')) === false, 'content filter does not failover');
assert(shouldFailover(httpError(400, 'context length exceeded')) === false, 'context length does not failover');

let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
const circuit = createCircuitBreaker({ now: () => nowMs });
for (let i = 0; i < 5; i += 1) {
  circuit.recordFailure('groq');
  nowMs += 10_000;
}
assert(circuit.isHealthy('groq') === false, 'five consecutive failures within 2 minutes open the circuit');
assert(circuit.isHealthy('openai') === true, 'fallback stays healthy when primary trips');
const health = getProviderHealth(circuit, chain);
assert(
  health.some((row) => row.id === 'groq' && row.healthy === false),
  'health snapshot marks primary unhealthy',
);
nowMs += 5 * 60_000 + 1;
assert(circuit.isHealthy('groq') === true, 'circuit closes after 5 minutes');

const served: string[] = [];
const failover = await executeWithFailover(
  chain,
  async (entry) => {
    if (entry.provider === 'groq') throw httpError(503, 'Service Unavailable');
    served.push(entry.provider);
    return { text: 'ok', provider: entry.provider, model: entry.model };
  },
);
assert(failover.provider === 'openai', '503 on primary completes on fallback');
assert(failover.model === 'gpt-4o-mini', 'fallback model is recorded');
assert(served[0] === 'openai', 'only fallback executed the work');

assert(queuePositionLabel(3) === 'In queue — 3 builds ahead', 'queue English label');

let clock = Date.parse('2026-08-17T12:00:00.000Z');
const sleeps: number[] = [];
const queue = createProviderQueue({
  concurrency: 1,
  maxWaitMs: 10 * 60_000,
  now: () => clock,
  sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
  },
});

const positions: number[] = [];
const firstHold = queue.acquire('groq', {
  jobId: 'job-a',
  onPosition: (n) => positions.push(n),
});
await firstHold.started;
assert(firstHold.position === 0, 'first slot has position 0 (running)');

const second = queue.acquire('groq', {
  jobId: 'job-b',
  onPosition: (n) => positions.push(n),
});
assert(second.position === 1, 'second job queues with position 1');
assert(queuePositionLabel(second.position) === 'In queue — 1 builds ahead', 'queued job shows one build ahead');

const rateLimited = queue.handleRateLimit('groq', { retryAfterSeconds: 2 });
assert(rateLimited.waitMs >= 2000 && rateLimited.waitMs <= 60_000, '429 respects Retry-After and caps at 60s');

firstHold.release();
const secondStarted = await second.started;
assert(secondStarted.ok === true, 'queued job starts after the slot frees (completes after backoff, does not fail)');
second.release();

const shortQueue = createProviderQueue({
  concurrency: 1,
  maxWaitMs: 50,
  now: () => clock,
  sleep: async (ms) => {
    clock += ms;
  },
});
const blocker = shortQueue.acquire('openai', { jobId: 'hold' });
await blocker.started;
const timed = shortQueue.acquire('openai', { jobId: 'late' });
const timedResult = await timed.started;
assert(timedResult.ok === false, 'job that cannot start within the wait cap fails');
assert(typeof timedResult.errorMessage === 'string' && timedResult.errorMessage.length > 0, 'queue timeout has an English message');
blocker.release();

// --- Part D: spend ceiling ---

assert(shouldNotifySpend80(79, 100, false) === false, 'under 80% does not notify');
assert(shouldNotifySpend80(80, 100, false) === true, '80% notifies once');
assert(shouldNotifySpend80(90, 100, true) === false, '80% notify is not repeated');
assert(shouldAutoPauseSpend(99.9, 100) === false, 'under 100% does not auto-pause');
assert(shouldAutoPauseSpend(100, 100) === true, '100% auto-pauses generation');
assert(pauseReasonLabel('SPEND_LIMIT') === PAUSE_REASON_AUTOMATIC, 'admin label: Automatic pause');
assert(pauseReasonLabel('MANUAL') === PAUSE_REASON_MANUAL, 'admin label: Manual pause');

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const WS = `ws_consumption_${suffix}`;
const USER = `user_consumption_${suffix}`;

try {
  await ensureDefaultPlan(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      email: `consumption-${suffix}@navroop.local`,
      name: 'Consumption Test',
      passwordHash: await hashPassword('ConsumeTest123'),
      role: 'ADMIN',
    },
  });
  await prisma.$executeRaw`
    INSERT INTO "Workspace" (
      id, "storageBytes", "creditsUsed", "creditsPeriodStart",
      "generationPaused", "sandboxMinutesUsed", "spendUsd", "spendAlert80Sent"
    ) VALUES (
      ${WS}, 0, 0, NOW(),
      false, 0, 0, false
    )
  `;

  const minutes = sandboxMinutesBetween(
    new Date('2026-08-17T10:00:00.000Z'),
    new Date('2026-08-17T10:12:00.000Z'),
  );
  await accrueSandboxMinutes(WS, minutes);
  const afterAccrue = await prisma.$queryRaw<Array<{ sandboxMinutesUsed: number }>>`
    SELECT "sandboxMinutesUsed" FROM "Workspace" WHERE id = ${WS}
  `;
  assert(afterAccrue[0]?.sandboxMinutesUsed === 12, 'reaper/shutdown accrue adds wall-clock minutes');

  await prisma.$executeRaw`
    UPDATE "Workspace" SET "sandboxMinutesUsed" = 300 WHERE id = ${WS}
  `;
  const refused = await checkSandboxMinutes(WS);
  assert(refused.ok === false, 'exhausted monthly minutes refuse a cold start');
  assert(refused.message === SANDBOX_MINUTES_EXHAUSTED, 'cold start uses the sandbox-time English message');

  await prisma.$executeRaw`
    UPDATE "Workspace"
    SET "monthlySpendLimitUsd" = 1, "spendUsd" = 0, "generationPaused" = false, "pauseReason" = NULL
    WHERE id = ${WS}
  `;
  const spend = await accrueSpend(WS, 1.05);
  assert(spend.generationPaused === true, 'crossing the spend limit pauses generation');
  assert(spend.pauseReason === 'SPEND_LIMIT', 'auto-pause reason is SPEND_LIMIT');
  assert(pauseReasonLabel(spend.pauseReason) === 'Automatic pause', 'admin UI can show Automatic pause');
} catch (error) {
  failed += 1;
  console.error('FAIL  db assertions', error);
} finally {
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`;
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
