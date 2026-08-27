import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Round 5, the two halves of "say what actually happened".
 *
 *  A. `runAiReview` is the only provider call the audit makes — a `generateText` carrying
 *     up to 40 000 input tokens of the user's source — and it reported nothing about
 *     itself. Neither it nor `runCodeScan` called `recordJobUsage`, `accrueSpend` or
 *     `logGenerationEvent`, so the money was on the operator's invoice and nowhere in the
 *     product. It now hands its usage back for the caller to record, including when the
 *     provider took the prompt and then failed — which is the most expensive outcome it
 *     has, and the one that used to report zero.
 *  B. `runA11yAudit` and `runLighthouseSeo` both fork a Chromium through
 *     `withHeadlessBrowser`, and the production image had none: `pnpm install
 *     --frozen-lockfile --ignore-scripts` skips Playwright's postinstall download and
 *     nothing else fetched a browser. Every run threw "Executable doesn't exist", and both
 *     panels filed it as a finding against the user's site — a defect they cannot fix,
 *     about a fault that is not theirs. The image now installs the browser, and the code
 *     tells the two failures apart in case a deployment does not.
 */

const ai = vi.hoisted(() => ({ generateText: vi.fn() }));
const providerManager = vi.hoisted(() => ({ getProviderForModel: vi.fn() }));
const browser = vi.hoisted(() => ({ withHeadlessBrowser: vi.fn() }));

vi.mock('ai', () => ({ generateText: ai.generateText }));
vi.mock('@/lib/ai/provider-manager', () => providerManager);
vi.mock('@/lib/ai/client-for-entry', () => ({
  chatModelForProvider: vi.fn(() => ({ id: 'model' })),
}));
vi.mock('@/lib/generation/prompt-cache', () => ({ buildCachedMessages: vi.fn(() => []) }));
vi.mock('@/lib/stack-prompts', () => ({ buildStablePromptPrefix: vi.fn(() => 'STABLE PREFIX') }));
vi.mock('@/lib/audit/headless-browser', () => browser);

import {
  a11yNeedsScanFinding,
  browserUnavailableFinding,
  isBrowserUnavailableError,
  runA11yAudit,
} from '@/lib/audit/a11y';
import { aiReviewNeedsScanFinding, runAiReview } from '@/lib/audit/ai-review';
import { lighthouseNeedsScanFinding, runLighthouseSeo } from '@/lib/seo/lighthouse';
import { toolFailedId } from '@/lib/audit/static/tool-fail';

/** Verbatim from Playwright 1.62 when the browser was never downloaded. */
const MISSING_BROWSER = new Error(
  [
    "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome",
    '╔═══════════════════════════════════════════════════════════════════════════╗',
    '║ Looks like Playwright was just installed or updated.                      ║',
    '║ Please run the following command to download new browsers:                ║',
    '║     playwright install                                                    ║',
    '╚═══════════════════════════════════════════════════════════════════════════╝',
  ].join('\n'),
);

/** A run that did launch a browser and then went wrong — a different sentence. */
const PAGE_BROKE = new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://preview/p1');

const SOURCE_FILE = { path: 'app/page.tsx', content: 'export default function Page(){}\n'.repeat(40) };

beforeEach(() => {
  vi.clearAllMocks();
  providerManager.getProviderForModel.mockResolvedValue({
    client: {},
    actualModel: 'deepseek-v4-flash',
  });
});

/* ------------------------------------------- A: a provider call reports what it spent */

describe('runAiReview hands back its usage', () => {
  it('reports the provider counts when the call succeeded', async () => {
    ai.generateText.mockResolvedValue({
      text: '{"findings":[]}',
      usage: { inputTokens: 39_000, outputTokens: 1_200 },
    });

    const result = await runAiReview({
      stack: 'NEXTJS',
      files: [SOURCE_FILE],
      staticFindings: [],
      userId: 'user-1',
    });

    expect(result.usage).toMatchObject({
      tokensIn: 39_000,
      tokensOut: 1_200,
      calls: 1,
      estimatedCalls: 0,
      model: 'deepseek-v4-flash',
    });
  });

  it('still reports a call the provider accepted and then failed', async () => {
    ai.generateText.mockRejectedValue(new Error('429 Too Many Requests'));

    const result = await runAiReview({
      stack: 'NEXTJS',
      files: [SOURCE_FILE],
      staticFindings: [],
      userId: 'user-1',
    });

    // The prompt was uploaded, so it was billed. Reporting null here is how the most
    // expensive outcome came to look like the cheapest one.
    expect(result.usage).not.toBeNull();
    expect(result.usage?.calls).toBe(1);
    expect(result.usage?.tokensIn).toBeGreaterThan(0);
    // …and the review itself is still reported as a check that could not run.
    expect(result.findings.map((row) => row.id)).toEqual([toolFailedId('ai-review')]);
  });

  it('reports no usage when nothing was ever sent', async () => {
    const skipped = await runAiReview({
      stack: 'NEXTJS',
      files: [],
      staticFindings: [],
      userId: 'user-1',
    });
    expect(skipped.usage).toBeNull();
    expect(ai.generateText).not.toHaveBeenCalled();

    providerManager.getProviderForModel.mockRejectedValue(new Error('No AI provider is configured'));
    const unconfigured = await runAiReview({
      stack: 'NEXTJS',
      files: [SOURCE_FILE],
      staticFindings: [],
      userId: 'user-1',
    });
    // A prompt that never left this process is not a charge.
    expect(unconfigured.usage).toBeNull();
  });
});

/* ---------------------------------------- B: no browser is our fault, not the user's */

describe('a deployment with no browser says so', () => {
  it('tells a missing binary apart from a run that went wrong', () => {
    expect(isBrowserUnavailableError(MISSING_BROWSER)).toBe(true);
    expect(isBrowserUnavailableError(new Error("Cannot find module 'playwright'"))).toBe(true);
    expect(isBrowserUnavailableError(PAGE_BROKE)).toBe(false);
    expect(isBrowserUnavailableError(null)).toBe(false);
  });

  it('reports the axe pass as unavailable on this deployment, not as a site defect', async () => {
    browser.withHeadlessBrowser.mockRejectedValue(MISSING_BROWSER);

    const findings = await runA11yAudit('https://preview/p1', []);

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe(browserUnavailableFinding().title);
    expect(findings[0].detail).toContain('Nothing is wrong with your site');
    expect(findings[0].fixable).toBe(false);
    // Still the tool-failure id, so the quality collector keeps reading the check as
    // "did not run" and records no `a11y_score` for it (F-705).
    expect(findings[0].id).toBe(toolFailedId('a11y'));
  });

  it('keeps the ordinary tool failure for a run that did launch a browser', async () => {
    browser.withHeadlessBrowser.mockRejectedValue(PAGE_BROKE);

    const findings = await runA11yAudit('https://preview/p1', []);

    expect(findings[0].id).toBe(toolFailedId('a11y'));
    expect(findings[0].detail).not.toContain('Nothing is wrong with your site');
  });

  it('files an unrunnable Lighthouse as a notice, never as a finding against the site', async () => {
    browser.withHeadlessBrowser.mockRejectedValue(MISSING_BROWSER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const findings = await runLighthouseSeo('https://preview/p1');

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('lighthouse:unavailable');
    // `low` was a defect in the user's site; this row is about ours. `info` is excluded
    // from the SEO score and renders under the panel's "Not checked" group.
    expect(findings[0].status).toBe('info');
    expect(findings[0].fixable).toBe(false);
    expect(findings[0].detail).toContain('Nothing is wrong with your site');
    warn.mockRestore();
  });

  it('says only that the run failed when a browser was there', async () => {
    browser.withHeadlessBrowser.mockRejectedValue(PAGE_BROKE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const findings = await runLighthouseSeo('https://preview/p1');

    expect(findings[0].status).toBe('info');
    expect(findings[0].detail).not.toContain('Nothing is wrong with your site');
    warn.mockRestore();
  });
});

/* ------------------------------------------------ the panel distinguishes the two states */

describe('a deferred check reads as waiting, not as failed and not as clean', () => {
  it('carries an id of its own so `toolFailed` keeps meaning "ran and failed"', () => {
    expect(a11yNeedsScanFinding().id).not.toBe(toolFailedId('a11y'));
    expect(aiReviewNeedsScanFinding().id).not.toBe(toolFailedId('ai-review'));
  });

  it('names the Scan button, because that is the reader’s next move', () => {
    for (const row of [a11yNeedsScanFinding(), aiReviewNeedsScanFinding()]) {
      expect(row.detail).toMatch(/press Scan/i);
      expect(row.fixable).toBe(false);
      expect(row.status).not.toBe('pass');
    }
    expect(lighthouseNeedsScanFinding().detail).toMatch(/press Scan/i);
    expect(lighthouseNeedsScanFinding().status).toBe('info');
  });
});

/* ---------------------------------------------------------- B: the image ships a browser */

describe('the production image can launch the browser the Scan button needs', () => {
  const docker = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

  it('installs Chromium and its system libraries', () => {
    // `--ignore-scripts` stays (supply-chain posture), so the download has to be explicit
    // the same way `prisma generate` is. Without this the audit's only real check of the
    // rendered site fails on every scan of every project.
    expect(docker).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    expect(docker).toMatch(/playwright install --with-deps chromium/);
  });

  it('pins the browser to the playwright the lockfile resolved, and fails the build if it drifts', () => {
    // A browser build only works with one playwright-core revision; a pin that quietly
    // parts from package.json ships a browser the app cannot launch, and the symptom is a
    // runtime launch failure on every scan rather than a build error.
    expect(docker).toMatch(/ARG PLAYWRIGHT_VERSION=\d+\.\d+\.\d+/);
    expect(docker).toMatch(/playwright@\$\{PLAYWRIGHT_VERSION\}/);
    expect(docker).toContain("require('playwright/package.json').version");
  });

  it('puts the browsers where the non-root app user can read them', () => {
    expect(docker).toMatch(/ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
    expect(docker).toMatch(/chmod -R a\+rX \/ms-playwright/);
    // The image still runs as the unprivileged user; installing a browser did not change that.
    expect(docker).toMatch(/USER nextjs/);
  });

  it('does not pull the two engines nothing here launches', () => {
    // `playwright`'s postinstall fetches chromium, firefox and webkit — about a gigabyte
    // for two browsers `withHeadlessBrowser` never opens.
    expect(docker).toMatch(/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/);
    expect(docker).not.toMatch(/playwright install --with-deps\s*$/m);
  });
});
