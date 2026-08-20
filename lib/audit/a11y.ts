import { createRequire } from 'node:module';
import type { Browser } from 'playwright';
import { withHeadlessBrowser } from './headless-browser';
import type { SeoFinding } from '@/lib/seo/types';
import { finding } from './findings';
import { toolFailedFinding } from './static/tool-fail';
import type { AxeViolation, CodeFinding, CodeSeverity } from './types';

const require = createRequire(import.meta.url);

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

async function axeOnPage(
  browser: Browser,
  url: string,
  width: number,
  label: string,
): Promise<CodeFinding[]> {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
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
    return findingsFromAxe(violations, label);
  } finally {
    await page.close().catch(() => undefined);
  }
}

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
    for (const row of [...desktop, ...mobile]) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }
    return dedupeA11yAgainstSeo([...merged.values()], seo);
  } catch (error) {
    return [toolFailedFinding('a11y', error)];
  }
}
