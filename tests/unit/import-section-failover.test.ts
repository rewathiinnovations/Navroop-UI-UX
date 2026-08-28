import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const failover = vi.hoisted(() => ({
  completeWithProviderFailover: vi.fn(),
}));

const ai = vi.hoisted(() => {
  let calls = 0;
  return {
    generateText: vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('Unauthorized') as Error & { status: number };
        error.status = 401;
        throw error;
      }
      return {
        text: '<file path="ok.tsx">ok</file>',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    reset() {
      calls = 0;
    },
  };
});

vi.mock('ai', () => ({ generateText: (...args: unknown[]) => ai.generateText(...args) }));
vi.mock('@/lib/ai/plan-complete', () => failover);
vi.mock('@/lib/ai/provider-manager', () => ({
  getProviderForModel: vi.fn(async () => {
    throw new Error('import sections must not call getProviderForModel');
  }),
}));
vi.mock('@/lib/ai/client-for-entry', () => ({
  chatModelForEntry: vi.fn(() => 'mock-model'),
  chatModelForProvider: vi.fn(() => 'mock-model'),
}));
vi.mock('@/lib/usage-costs', () => ({ logGenerationEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/jobs/step-failure', () => ({ recordJobStepFailure: vi.fn(async () => undefined) }));
vi.mock('sharp', () => ({
  default: () => ({
    metadata: async () => ({ width: 1440, height: 900 }),
    extract: () => ({
      png: () => ({
        toBuffer: async () => Buffer.from('png'),
      }),
    }),
  }),
}));

const { generateImportedSections } = await import('@/lib/import/generate-sections');
const { recordJobStepFailure } = await import('@/lib/jobs/step-failure');

const SOURCE = fileURLToPath(new URL('../../lib/import/generate-sections.ts', import.meta.url));

beforeEach(() => {
  vi.clearAllMocks();
  ai.reset();
});

describe('import section generation uses provider failover', () => {
  it('routes the default completer through completeWithProviderFailover, not getProviderForModel', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source).toMatch(/completeWithProviderFailover\(/);
    expect(source).toMatch(/chatModelForEntry\(/);
    expect(source).not.toMatch(/getProviderForModel\(/);
    expect(source).not.toMatch(/generateText\(\{[\s\S]*model:\s*chatModelForProvider/);
  });

  it('walks the chain when the first provider is rejected, then continues the section', async () => {
    failover.completeWithProviderFailover.mockImplementation(async ({ run }) => {
      try {
        await run(
          { provider: 'deepseek', model: 'first-rejected' },
          { signal: new AbortController().signal, env: {} },
        );
      } catch {
        // First entry rejected — the helper walks on.
      }
      const second = await run(
        { provider: 'deepseek', model: 'second-ok' },
        { signal: new AbortController().signal, env: {} },
      );
      return {
        result: second,
        provider: 'deepseek',
        model: 'second-ok',
        failedOver: true,
        attempts: [
          { provider: 'deepseek', model: 'first-rejected', ok: false },
          { provider: 'deepseek', model: 'second-ok', ok: true },
        ],
      };
    });

    const result = await generateImportedSections({
      projectId: 'p1',
      userId: 'u1',
      stack: 'NEXTJS',
      designDirection: 'minimal',
      mode: 'reimagine',
      capture: {
        sourceUrl: 'https://example.com',
        desktopPng: Buffer.from('desk'),
        tokens: {
          fontFamily: 'Inter',
          fontSizes: ['16px'],
          colors: ['#111'],
          radii: ['8px'],
          spacingRhythm: ['16px'],
        },
        images: [],
        firecrawlText: 'Hello',
        firecrawl: { ok: true, markdown: 'Hello' },
        capturedAt: new Date(),
      },
      sections: [
        {
          id: 'hero',
          label: 'Hero',
          purpose: 'intro',
          contentSummary: 'Headline',
          approximateYRange: [0, 400],
        },
      ],
      assets: [],
    });

    expect(failover.completeWithProviderFailover).toHaveBeenCalled();
    expect(result.filesXml).toContain('ok.tsx');
    expect(vi.mocked(recordJobStepFailure)).not.toHaveBeenCalled();
  });
});
