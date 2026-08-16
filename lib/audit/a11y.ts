import { createRequire } from 'node:module';
import { chromium } from 'playwright';
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

async function runAxeOnPage(url: string, width: number, label: string): Promise<CodeFinding[]> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
    const axePath = require.resolve('axe-core');
    await page.addScriptTag({ path: axePath });
    const violations = (await page.evaluate(() => {
      const axe = (globalThis as { axe?: { run: () => Promise<{ violations?: AxeViolation[] }> } }).axe;
      if (!axe) return [];
      return axe.run().then((result) => result.violations || []);
    })) as AxeViolation[];
    return findingsFromAxe(violations, label);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function runA11yAudit(previewUrl: string | null, seo: SeoFinding[]): Promise<CodeFinding[]> {
  if (!previewUrl?.trim()) {
    return [toolFailedFinding('a11y', new Error('No preview URL'))];
  }
  try {
    const [desktop, mobile] = await Promise.all([
      runAxeOnPage(previewUrl, 1280, 'desktop'),
      runAxeOnPage(previewUrl, 390, '390px'),
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
