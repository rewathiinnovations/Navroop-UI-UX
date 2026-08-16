import type { SeoFinding } from './types';

function openFindings(findings: SeoFinding[]): SeoFinding[] {
  return findings.filter((row) => !row.ignored && row.status !== 'pass' && row.fixable !== false);
}

export function buildFixInstruction(target: SeoFinding): string {
  return [
    'Fix this SEO / AEO issue in the generated site. This is a build edit — change only the files required.',
    `Issue: ${target.title}`,
    `Detail: ${target.detail}`,
    `Category: ${target.category}`,
    'Follow the project SEO rules: unique 50-60 character titles, 140-160 character descriptions, OG + Twitter (summary_large_image), canonical, JSON-LD on public pages, html lang + viewport, robots and sitemap. No placeholders.',
  ].join('\n');
}

export function buildFixAllInstruction(findings: SeoFinding[]): string {
  const open = openFindings(findings);
  const list = open.map((row, index) => `${index + 1}. [${row.category} / ${row.status}] ${row.title} — ${row.detail}`).join('\n');
  return [
    'Fix these SEO / AEO issues together in one edit. Change only the files required.',
    list || 'No open SEO findings.',
    'Follow the project SEO rules: unique 50-60 character titles, 140-160 character descriptions, OG + Twitter (summary_large_image), canonical, JSON-LD on public pages, html lang + viewport, robots and sitemap. No placeholders.',
  ].join('\n\n');
}
