import { createRequire } from 'node:module';
import type { Browser } from 'playwright';
import { withHeadlessBrowser } from './headless-browser';
import type { SeoFinding } from '@/lib/seo/types';
import { finding } from './findings';
import { captureRuntimeMessages, runtimeFindings, type RuntimeMessage } from './runtime-errors';
import { toolFailedFinding, toolFailedId } from './static/tool-fail';
import type { AxeViolation, CodeFinding, CodeSeverity } from './types';

const require = createRequire(import.meta.url);

/**
 * The deployment has no Chromium to launch, as opposed to a run that launched one and
 * went wrong.
 *
 * `pnpm install --frozen-lockfile --ignore-scripts` (Dockerfile) deliberately skips
 * Playwright's postinstall download, so an image that does not install the browser
 * explicitly answers every axe run and every Lighthouse run with the same launch
 * failure. Reported as a defect that is the user's to fix, that failure lands on the
 * Quality panel of every project after every build and reads as "your site broke the
 * accessibility checker" — which is a lie about their site and a dead end besides,
 * since nothing they can write will make a missing binary appear.
 *
 * Matched on Playwright's own wording rather than on an error class, because the throw
 * comes back as a plain Error: `browserType.launch: Executable doesn't exist at
 * <path>` followed by the box telling the operator to run `playwright install`. The `.`
 * covers both apostrophe spellings. The third arm is the same condition one layer
 * earlier — `playwright` itself missing from the deployed bundle, which is a resolution
 * error rather than a launch error but is the identical fact for the person reading the
 * panel. Shared with `lib/seo/lighthouse.ts`, which goes through the same
 * `withHeadlessBrowser` and owes the user the same answer.
 */
export function isBrowserUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /executable doesn.t exist|playwright install|cannot find module '?playwright/i.test(
    message,
  );
}

/**
 * The words the panel gets when there is no browser on this deployment.
 *
 * It keeps `toolFailedId('a11y')` so the quality collector still reads the check as
 * "did not run" and records no `a11y_score` — a check that never executed and a clean
 * page are both zero violations, and only the id tells them apart (F-705).
 */
export function browserUnavailableFinding(): CodeFinding {
  return finding({
    id: toolFailedId('a11y'),
    category: 'tool',
    status: 'low',
    title: 'Accessibility check is unavailable on this deployment',
    detail:
      'This installation has no headless browser, so the accessibility pass could not be run. Nothing is wrong with your site — an operator has to install the browser for this check to work.',
    fixable: false,
  });
}

export function mapAxeImpact(impact: string | null | undefined): CodeSeverity {
  if (impact === 'critical') return 'high';
  if (impact === 'serious') return 'medium';
  return 'low';
}

export function findingsFromAxe(violations: AxeViolation[], viewport: string): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const violation of violations) {
    for (const node of violation.nodes || []) {
      const selector = node.target?.[0] || '';
      out.push(
        finding({
          id: `a11y:${violation.id}:${selector || viewport}`,
          category: 'a11y',
          status: mapAxeImpact(violation.impact),
          // `status` is the four-value display severity; `impact` is what axe
          // said, and it is what the quality score weights by (F-816).
          impact: violation.impact ?? undefined,
          title: violation.help,
          detail: `${violation.help} (${viewport}${selector ? `, ${selector}` : ''}).`,
          selector: selector || undefined,
        }),
      );
    }
  }
  return out;
}

const ALT_RE = /alt text|missing alt|alternate text|image-alt/i;
const LANG_RE = /html lang|html-has-lang/i;
const VIEWPORT_RE = /viewport/i;
const TITLE_RE = /document-title|page title|title is missing/i;

function overlapKey(text: string): string | null {
  if (ALT_RE.test(text)) return 'alt';
  if (LANG_RE.test(text)) return 'lang';
  if (VIEWPORT_RE.test(text)) return 'viewport';
  if (TITLE_RE.test(text)) return 'title';
  return null;
}

export function dedupeA11yAgainstSeo(a11y: CodeFinding[], seo: SeoFinding[]): CodeFinding[] {
  const seoKeys = new Set(
    seo
      .filter((row) => row.status !== 'pass')
      .map((row) => overlapKey(`${row.id} ${row.title} ${row.detail}`))
      .filter((key): key is string => Boolean(key)),
  );
  if (seoKeys.size === 0) return a11y;
  return a11y.filter((row) => {
    const key = overlapKey(`${row.id} ${row.title} ${row.detail}`);
    return !key || !seoKeys.has(key);
  });
}

/**
 * One viewport pass: what axe found, and what the page said while it was open.
 *
 * The two travel together because they are one page load. Nothing else in the pipeline
 * ever runs the generated site, so a second load purely to listen for exceptions would
 * mean a second Chromium page for a fact this one is already in a position to observe —
 * see the module comment in `lib/audit/runtime-errors.ts`.
 */
async function axeOnPage(
  browser: Browser,
  url: string,
  width: number,
  label: string,
): Promise<{ a11y: CodeFinding[]; runtime: RuntimeMessage[] }> {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
  // Before the goto, not after: a component that throws on its first render has already
  // thrown by the time the navigation settles, and a listener attached afterwards would
  // hear nothing and report the page as clean.
  const runtime = captureRuntimeMessages(page);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
    const axePath = require.resolve('axe-core');
    await page.addScriptTag({ path: axePath });
    const violations = (await page.evaluate(() => {
      // axe-core registers itself on the page's globalThis through the injected
      // script tag; the Node type for globalThis cannot express that runtime
      // addition, so the shape is named once here rather than asserted inline.
      const pageGlobal = globalThis as {
        axe?: { run: () => Promise<{ violations?: AxeViolation[] }> };
      };
      const runner = pageGlobal.axe;
      if (!runner) return [];
      return runner.run().then((result) => result.violations || []);
    })) as AxeViolation[];
    // Read after the axe run rather than straight after the goto: console events are
    // delivered on the CDP connection, not synchronously with the page's own execution,
    // and the evaluate round trip is the last point at which this pass is still waiting
    // on the page for anything.
    return { a11y: findingsFromAxe(violations, label), runtime: runtime.messages() };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * The audit's whole browser pass: `a11y` rows from axe and `runtime` rows from the page.
 *
 * The name is axe's because axe is what pays for the Chromium; the runtime capture is a
 * passenger on the same two loads. Both categories come back in one array so the caller's
 * existing failure handling covers both — the pass is atomic, and a throw anywhere in it
 * (no browser, a navigation timeout, an axe injection that was refused) means neither
 * check reached a verdict, which is exactly what the `tool:a11y` rows below already say.
 * `runCodeScan` splits the array by category; see the `runtime` arm there.
 */
export async function runA11yAudit(
  previewUrl: string | null,
  seo: SeoFinding[],
): Promise<CodeFinding[]> {
  if (!previewUrl?.trim()) {
    return [toolFailedFinding('a11y', new Error('No preview URL'))];
  }
  try {
    // One browser, two pages, one at a time — the desktop and 390px passes used
    // to launch a Chromium each, concurrently, inside the serving process (F-751).
    const [desktop, mobile] = await withHeadlessBrowser(async ({ browser }) => [
      await axeOnPage(browser, previewUrl, 1280, 'desktop'),
      await axeOnPage(browser, previewUrl, 390, '390px'),
    ]);
    const merged = new Map<string, CodeFinding>();
    for (const row of [...desktop.a11y, ...mobile.a11y]) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }
    // The runtime rows are deliberately outside `dedupeA11yAgainstSeo`. That function
    // matches on words — "alt text", "viewport", "title" — anywhere in a finding's id,
    // title or detail, and a runtime message quotes the page's own error text, so a
    // TypeError mentioning a `title` property would be silently dropped because the SEO
    // audit happened to report a missing page title. The overlap it exists to remove is
    // between axe and SEO; nothing in SEO restates a thrown exception.
    return [
      ...dedupeA11yAgainstSeo([...merged.values()], seo),
      ...runtimeFindings([...desktop.runtime, ...mobile.runtime]),
    ];
  } catch (error) {
    // "There is no browser here" and "the browser choked on this page" are two
    // different sentences with two different first moves; see
    // {@link isBrowserUnavailableError}.
    if (isBrowserUnavailableError(error)) return [browserUnavailableFinding()];
    return [toolFailedFinding('a11y', error)];
  }
}

/**
 * The row that says this check is waiting for the user, not that it failed.
 *
 * An automatic post-build scan runs only the free, fast checks: axe needs a Chromium
 * launch, so it stays behind the Scan button where the user asked for it. Without a
 * row saying so the panel showed a partial result as if it were a whole one — which is
 * a worse lie than showing nothing, because the reader has no way to tell a page with
 * no accessibility defects from a page nobody looked at. `fixable: false` because there
 * is nothing here for the model to fix; the id is deliberately NOT
 * `toolFailedId('a11y')`, so `toolFailed()` keeps meaning "ran and failed".
 */
export function a11yNeedsScanFinding(): CodeFinding {
  return finding({
    id: 'tool:a11y:needs-scan',
    category: 'tool',
    status: 'low',
    title: 'Accessibility check not run yet',
    detail:
      'The automatic check after a build runs only the free, fast checks. The accessibility pass opens your site in a browser, so it runs when you press Scan.',
    fixable: false,
  });
}
