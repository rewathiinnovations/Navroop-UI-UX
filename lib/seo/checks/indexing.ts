import { extractDocument } from '../html';
import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

function hasNoindex(input: SeoScanInput): boolean {
  const header = input.live?.headers['x-robots-tag'] || '';
  if (/noindex/i.test(header)) return true;
  const doc = extractDocument(input.live?.html || '');
  if (/noindex/i.test(doc.robots)) return true;
  const home = input.files.find((file) => /(?:^|\/)(index\.html|app\/page\.(tsx|jsx|js)|src\/pages\/index\.(astro|vue)|src\/routes\/\+page\.svelte)$/i.test(file.path.replace(/\\/g, '/')));
  return Boolean(home && /noindex/i.test(home.content));
}

export function checkIndexing(input: SeoScanInput): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const status = input.live?.status;

  if (status !== undefined && (status === 0 || status >= 400)) {
    findings.push(
      finding({
        id: 'indexing:homepage-error',
        category: 'indexing',
        status: 'high',
        title: 'Homepage preview returned an error',
        detail: `Preview URL responded with ${status || 'a network error'}. Crawlers cannot index a failing homepage.`,
      }),
    );
  }

  if (hasNoindex(input)) {
    findings.push(
      finding({
        id: 'indexing:noindex',
        category: 'indexing',
        status: 'high',
        title: 'Sitewide noindex is set',
        detail: 'A noindex robots directive on the homepage blocks indexing. Remove it from public marketing pages.',
      }),
    );
  } else if (!findings.length) {
    findings.push(
      finding({
        id: 'indexing:public',
        category: 'indexing',
        status: 'pass',
        title: 'Homepage is indexable',
        detail: 'No sitewide noindex or homepage error was detected.',
        fixable: false,
      }),
    );
  }

  return findings;
}
