/**
 * Every provider call this product makes is recorded, and recorded once.
 *
 * Completing the `chatModelForEntry` rollout stopped three helper calls from 404ing
 * against DeepSeek's non-existent `/responses` endpoint. That was the right fix, and it
 * turned three dead code paths into live recurring spend: memory extraction after every
 * successful generation, skill matching per chat message and per plan, and page
 * segmentation per URL import. None of them held a Job row, so `recordJobUsage` could not
 * cover them, and none of them wrote a `GenerationEvent` either. A workspace doing 200
 * chat turns a day put several hundred extra completions on the operator's invoice while
 * `Workspace.spendUsd` stood still, /admin/usage showed none of it, and the documented
 * 100 %-of-limit auto-pause (`pauseReason=SPEND_LIMIT`) could not fire on any of it.
 *
 * These cases pin the seam that closed it, at both ends:
 *
 *   - each of the three call sites hands `recordHelperCallUsage` the tokens it spent,
 *     including on the failure path, where the provider took the prompt and billed for it;
 *   - `recordHelperCallUsage` prices that, moves the ceiling, and files the row;
 *   - `logGenerationEvent` moves the ceiling only for the caller that opted in, because a
 *     build already accrued the same tokens through `recordJobUsage`;
 *   - and a memory extraction that failed no longer answers the same thing as one that
 *     found nothing worth keeping.
 *
 * The AI SDK is stubbed and the provider client is never built; everything between the
 * call site and the accounting — `RunUsage`, the pricing, the accrual — is the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODEL = 'deepseek-v4-flash';

const ai = vi.hoisted(() => ({ generateText: vi.fn(), generateObject: vi.fn() }));
vi.mock('ai', () => ai);

const provider = vi.hoisted(() => ({ getProviderForModel: vi.fn() }));
vi.mock('@/lib/ai/provider-manager', () => provider);
vi.mock('@/lib/ai/client-for-entry', () => ({
  chatModelForProvider: vi.fn((_client: unknown, modelId: string) => ({ modelId })),
  chatModelForEntry: vi.fn((_entry: unknown, _env: unknown, modelId: string) => ({ modelId })),
}));

// Import sections now complete through the shared failover helper, not getProviderForModel.
vi.mock('@/lib/ai/plan-complete', () => ({
  completeWithProviderFailover: async ({
    run,
  }: {
    run: (
      entry: { provider: string; model: string },
      ctx: { signal: AbortSignal; env: Record<string, string | undefined> },
    ) => Promise<unknown>;
  }) => {
    const result = await run(
      { provider: 'deepseek', model: MODEL },
      { signal: new AbortController().signal, env: {} },
    );
    return { result, model: MODEL, provider: 'deepseek' };
  },
}));

const db = vi.hoisted(() => ({
  generationEventCreate: vi.fn(),
  /** Nothing configured: pricing falls to the built-in DeepSeek list price, deterministically. */
  appSettingFindUnique: vi.fn(async () => null),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    generationEvent: { create: db.generationEventCreate },
    appSetting: { findUnique: db.appSettingFindUnique },
  },
}));

const spend = vi.hoisted(() => ({ accrueSpend: vi.fn(async () => undefined) }));
vi.mock('@/lib/plans/spend', () => spend);

// Neither belongs to a helper call, and both would reach the database.
vi.mock('@/lib/prompts/version', () => ({ stampActivePromptHash: vi.fn(async () => 'v1') }));
vi.mock('@/lib/signals/collect', () => ({ maybeSettleFollowups: vi.fn(async () => undefined) }));

/**
 * The call sites are exercised against a stubbed accounting module, so a case can assert
 * on exactly what each one reports. The accounting module itself is then imported for
 * real, further down, and tested on its own terms.
 */
const usage = vi.hoisted(() => ({
  recordHelperCallUsage: vi.fn(async () => ({ usd: 0, eventId: null })),
  logGenerationEvent: vi.fn(async () => 'evt_stub'),
}));
vi.mock('@/lib/usage-costs', () => usage);

// Dynamic, not static: every `vi.mock` above has to register before the modules under
// test evaluate their own imports.
const { extractMemoriesAfterGeneration } = await import('@/lib/memory/extract');
const { defaultSkillRanker } = await import('@/lib/skills/match');
const { segmentPage } = await import('@/lib/import/segment');
const { generateImportFallback } = await import('@/lib/import/generate-sections');
const { WORKSPACE_ROW_ID } = await import('@/lib/storage/usage');
const realUsage = await vi.importActual<typeof import('@/lib/usage-costs')>('@/lib/usage-costs');

/** What a provider that answered reports back. */
const ANSWERED = { inputTokens: 480, outputTokens: 120 };

function pageCapture() {
  return {
    sourceUrl: 'https://example.com',
    desktopPng: Buffer.from('desktop'),
    tokens: {
      fontFamily: 'Inter',
      fontSizes: ['16px'],
      colors: ['#111111'],
      radii: ['8px'],
      spacingRhythm: ['8px'],
    },
    images: [],
    firecrawlText: 'Hero headline. Pricing. Footer.',
    capturedAt: new Date('2026-08-19T00:00:00Z'),
  };
}

const SECTIONS = [
  {
    id: 'hero',
    label: 'Hero',
    purpose: 'headline',
    contentSummary: 'headline and CTA',
    approximateYRange: [0, 600],
  },
];

function extract(deps: { complete?: never } = {}) {
  return extractMemoriesAfterGeneration(
    'proj_1',
    { sourceMessage: 'always write the copy in Norwegian', userId: 'user_1' },
    {
      isEnabled: async () => true,
      listActiveContents: async () => [],
      insertPending: async () => undefined,
      ...deps,
    },
  );
}

function rankSkills() {
  return defaultSkillRanker({
    userMessage: 'add a pricing table',
    projectContext: 'a bakery site',
    skills: [{ id: 'pricing', name: 'Pricing', description: 'pricing sections' }],
    userId: 'user_1',
  });
}

/** The single recorded call, so a case can assert on more than one field of it. */
function recordedHelperCall() {
  expect(usage.recordHelperCallUsage).toHaveBeenCalledTimes(1);
  return usage.recordHelperCallUsage.mock.calls[0][0] as unknown as Record<string, unknown>;
}

/**
 * The `event` names the logger emitted this case. `log` writes one JSON line per call and
 * spreads itself across all four console methods by level, so all four are captured.
 */
let lines: string[];
/**
 * Restored one by one rather than through `vi.restoreAllMocks`, which would also strip the
 * inline implementations off the module factories above and leave the next case running
 * against a `chatModelForProvider` that returns nothing.
 */
const consoleSpies: { mockRestore: () => void }[] = [];

function loggedEvents(): string[] {
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: unknown };
      return typeof parsed.event === 'string' ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getProviderForModel.mockResolvedValue({ client: {}, actualModel: MODEL });
  db.generationEventCreate.mockResolvedValue({ id: 'evt_1' });
  db.appSettingFindUnique.mockResolvedValue(null);
  lines = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    consoleSpies.push(
      vi.spyOn(console, method).mockImplementation((line: unknown) => lines.push(String(line))),
    );
  }
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe('the three provider calls that hold no Job row report what they spent', () => {
  it('memory extraction records the completion it fired after the generation settled', async () => {
    ai.generateText.mockResolvedValue({ text: '[]', usage: ANSWERED });

    const result = await extract();

    expect(result).toEqual({ ok: true, inserted: 0 });
    expect(recordedHelperCall()).toMatchObject({
      kind: 'memory_extract',
      projectId: 'proj_1',
      userId: 'user_1',
      tokensIn: ANSWERED.inputTokens,
      tokensOut: ANSWERED.outputTokens,
      calls: 1,
      estimatedCalls: 0,
      model: MODEL,
    });
  });

  it('skill matching records the call it makes per chat message and per plan', async () => {
    ai.generateObject.mockResolvedValue({ object: { matches: [] }, usage: ANSWERED });

    await rankSkills();

    // No `projectId`: nothing threads one into `SkillRanker`. The spend is still
    // accrued — `recordHelperCallUsage` is what decides an unattributed call is
    // reported rather than dropped.
    expect(recordedHelperCall()).toMatchObject({
      kind: 'skill_match',
      userId: 'user_1',
      tokensIn: ANSWERED.inputTokens,
      tokensOut: ANSWERED.outputTokens,
      calls: 1,
    });
  });

  it('page segmentation records the import call that carries a full-page screenshot', async () => {
    ai.generateObject.mockResolvedValue({ object: { sections: SECTIONS }, usage: ANSWERED });

    const sections = await segmentPage({
      capture: pageCapture(),
      userId: 'user_1',
      projectId: 'proj_1',
    });

    expect(sections).toHaveLength(1);
    expect(recordedHelperCall()).toMatchObject({
      kind: 'import_segment',
      projectId: 'proj_1',
      userId: 'user_1',
      tokensIn: ANSWERED.inputTokens,
      calls: 1,
    });
  });

  it('records nothing when the caller supplied its own completion and no request went out', async () => {
    // `deps.complete` is the injection seam the tests and the pipeline use. It bypasses
    // the provider entirely, so charging for it would invent spend.
    const result = await extractMemoriesAfterGeneration(
      'proj_1',
      { sourceMessage: 'always write the copy in Norwegian' },
      {
        isEnabled: async () => true,
        listActiveContents: async () => [],
        insertPending: async () => undefined,
        complete: async () => '[]',
      },
    );

    expect(result).toEqual({ ok: true, inserted: 0 });
    expect(usage.recordHelperCallUsage).not.toHaveBeenCalled();
  });
});

describe('a call the provider accepted and then failed is still charged', () => {
  /**
   * The most expensive outcome each of these has, and the one that used to report zero:
   * the prompt was uploaded and billed, the answer never arrived. `RunUsage.claim` in the
   * `finally` charges it from the prompt and flags it as an estimate.
   */
  it('charges a refused memory extraction from its prompt', async () => {
    ai.generateText.mockRejectedValue(new Error('503 Service Unavailable'));

    const result = await extract();

    expect(result.ok).toBe(false);
    const call = recordedHelperCall();
    expect(call).toMatchObject({ kind: 'memory_extract', calls: 1, estimatedCalls: 1 });
    expect(call.tokensIn).toBeGreaterThan(0);
  });

  it('charges a refused skill match, which still throws to its caller', async () => {
    ai.generateObject.mockRejectedValue(new Error('429 Too Many Requests'));

    await expect(rankSkills()).rejects.toThrow('429 Too Many Requests');

    const call = recordedHelperCall();
    expect(call).toMatchObject({ kind: 'skill_match', calls: 1, estimatedCalls: 1 });
    expect(call.tokensIn).toBeGreaterThan(0);
  });

  it('charges a refused segmentation', async () => {
    ai.generateObject.mockRejectedValue(new Error('provider timeout'));

    await expect(
      segmentPage({ capture: pageCapture(), userId: 'user_1', projectId: 'proj_1' }),
    ).rejects.toThrow('provider timeout');

    const call = recordedHelperCall();
    expect(call).toMatchObject({ kind: 'import_segment', calls: 1, estimatedCalls: 1 });
    expect(call.tokensIn).toBeGreaterThan(0);
  });
});

describe('a failed extraction is not an empty one', () => {
  it('answers ok:true only when the model was read and had nothing durable to propose', async () => {
    ai.generateText.mockResolvedValue({ text: '[]', usage: ANSWERED });

    await expect(extract()).resolves.toEqual({ ok: true, inserted: 0 });
  });

  it('answers ok:false when the provider refused', async () => {
    ai.generateText.mockRejectedValue(new Error('model down'));

    const result = await extract();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ inserted: 0, error: 'model down' });
  });

  it('answers ok:false when the completion came back empty, which is what truncation looks like', async () => {
    // The reasoning budget ate the output budget. Billed in full, nothing to read — and
    // for two rounds of fixes this was reported as "the user said nothing worth
    // remembering", which is how a dead extraction path stayed invisible.
    ai.generateText.mockResolvedValue({ text: '', usage: ANSWERED });

    const result = await extract();

    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain('empty');
    expect(recordedHelperCall()).toMatchObject({ kind: 'memory_extract', calls: 1 });
  });

  it('answers ok:false when the completion was not the JSON array the prompt asked for', async () => {
    ai.generateText.mockResolvedValue({ text: 'Sure! Here are the memories:', usage: ANSWERED });

    await expect(extract()).resolves.toMatchObject({ ok: false, inserted: 0 });
  });

  it('still never throws — it runs detached from a generation that already succeeded', async () => {
    ai.generateText.mockRejectedValue(new Error('model down'));

    await expect(extract()).resolves.toBeTruthy();
  });
});

describe('recordHelperCallUsage: price it, move the ceiling, file the row', () => {
  const CHARGED = {
    kind: 'memory_extract' as const,
    projectId: 'proj_1',
    userId: 'user_1',
    tokensIn: 100_000,
    tokensOut: 20_000,
    calls: 1,
    provider: 'deepseek',
    model: MODEL,
  };

  it('accrues the same number it writes to the event row', async () => {
    const { usd, eventId } = await realUsage.recordHelperCallUsage(CHARGED);

    expect(usd).toBeGreaterThan(0);
    expect(eventId).toBe('evt_1');
    // One number for one call: /admin/usage and `Workspace.spendUsd` cannot describe the
    // same helper call with two different figures.
    expect(spend.accrueSpend).toHaveBeenCalledWith(WORKSPACE_ROW_ID, usd);
    expect(db.generationEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj_1',
          userId: 'user_1',
          kind: 'memory_extract',
          estimatedCost: usd,
        }),
      }),
    );
  });

  it('moves the ceiling even when the analytics row cannot be written', async () => {
    db.generationEventCreate.mockRejectedValue(new Error('deadlock detected'));

    const { usd, eventId } = await realUsage.recordHelperCallUsage(CHARGED);

    expect(eventId).toBeNull();
    expect(spend.accrueSpend).toHaveBeenCalledWith(WORKSPACE_ROW_ID, usd);
    // The failed write says so as itself. It must NOT also file the call as
    // unattributed: that line's whole claim is "this call site does not know its project
    // or its user", and this one named both.
    expect(loggedEvents()).toContain('usage.helper_event_not_written');
    expect(loggedEvents()).not.toContain('usage.helper_call_unattributed');
  });

  it('accrues an unattributed call rather than dropping it', async () => {
    // Skill matching's shape: a user, no project. A row needs both, the ceiling needs
    // neither, and the ceiling is the half that keeps the auto-pause honest.
    const { usd, eventId } = await realUsage.recordHelperCallUsage({
      kind: 'skill_match',
      userId: 'user_1',
      tokensIn: 50_000,
      tokensOut: 1_000,
      calls: 1,
      model: MODEL,
    });

    expect(usd).toBeGreaterThan(0);
    expect(eventId).toBeNull();
    // Not even attempted: a create missing either column throws at the database.
    expect(db.generationEventCreate).not.toHaveBeenCalled();
    expect(spend.accrueSpend).toHaveBeenCalledWith(WORKSPACE_ROW_ID, usd);
    expect(loggedEvents()).toContain('usage.helper_call_unattributed');
  });

  it('records nothing at all when no request was sent', async () => {
    const result = await realUsage.recordHelperCallUsage({
      kind: 'skill_match',
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
    });

    expect(result).toEqual({ usd: 0, eventId: null });
    expect(spend.accrueSpend).not.toHaveBeenCalled();
    expect(db.generationEventCreate).not.toHaveBeenCalled();
  });

  it('files the helper kind under its own name, never as a generation', async () => {
    // `GenerationEvent.kind` is free text, and /admin/usage counts generations by an
    // explicit list. A helper row disguised as `followup` would inflate the Generations
    // tile by up to three per chat turn — a new wrong number bought with a fix for an
    // old one.
    await realUsage.recordHelperCallUsage(CHARGED);

    const data = (db.generationEventCreate.mock.calls[0][0] as { data: { kind: string } }).data;
    expect(realUsage.HELPER_CALL_KINDS).toContain(data.kind);
    expect(['initial', 'followup', 'plan', 'image']).not.toContain(data.kind);
  });
});

describe('logGenerationEvent moves the ceiling only for the caller that owns the call', () => {
  const EVENT = {
    projectId: 'proj_1',
    userId: 'user_1',
    kind: 'followup' as const,
    isUrlClone: false,
    inputTokens: 40_000,
    outputTokens: 9_000,
    model: MODEL,
  };

  it('leaves it alone for a build, whose tokens recordJobUsage already accrued', async () => {
    await realUsage.logGenerationEvent(EVENT);

    expect(db.generationEventCreate).toHaveBeenCalledTimes(1);
    expect(spend.accrueSpend).not.toHaveBeenCalled();
  });

  it('moves it for an event that is the only record of its call', async () => {
    await realUsage.logGenerationEvent({ ...EVENT, accrueToSpendCeiling: true });

    expect(spend.accrueSpend).toHaveBeenCalledTimes(1);
    const [, usd] = spend.accrueSpend.mock.calls[0] as unknown as [string, number];
    expect(usd).toBeGreaterThan(0);
  });

  it('moves it even when the row write failed, because the tokens were spent either way', async () => {
    db.generationEventCreate.mockRejectedValue(new Error('deadlock detected'));

    const eventId = await realUsage.logGenerationEvent({ ...EVENT, accrueToSpendCeiling: true });

    expect(eventId).toBeNull();
    expect(spend.accrueSpend).toHaveBeenCalledTimes(1);
  });
});

describe('the URL-import section writer is the caller that opts in', () => {
  it('books its own spend onto the ceiling — nothing runs recordJobUsage for an IMPORT job', async () => {
    ai.generateText.mockResolvedValue({
      text: '<file path="app/page.tsx">export default function Page() { return null; }</file>',
      usage: { inputTokens: 900, outputTokens: 4_000 },
    });

    await generateImportFallback({
      projectId: 'proj_1',
      userId: 'user_1',
      stack: 'NEXTJS',
      designDirection: '',
      mode: 'replicate',
      capture: pageCapture(),
      assets: [],
    });

    expect(usage.logGenerationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj_1',
        userId: 'user_1',
        isUrlClone: true,
        inputTokens: 900,
        outputTokens: 4_000,
        accrueToSpendCeiling: true,
      }),
    );
  });

  it('reports a section call that failed after the prompt went out', async () => {
    ai.generateText.mockRejectedValue(new Error('provider timeout'));

    await expect(
      generateImportFallback({
        projectId: 'proj_1',
        userId: 'user_1',
        stack: 'NEXTJS',
        designDirection: '',
        mode: 'replicate',
        capture: pageCapture(),
        assets: [],
      }),
    ).rejects.toThrow('provider timeout');

    const event = usage.logGenerationEvent.mock.calls[0][0] as unknown as {
      inputTokens: number;
      accrueToSpendCeiling: boolean;
    };
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.accrueToSpendCeiling).toBe(true);
  });
});
