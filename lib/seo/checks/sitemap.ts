import { finding } from '../findings';
import type { SeoFinding, SeoScanInput } from '../types';

function hasSitemap(input: SeoScanInput): boolean {
  if (
    input.liveSitemap &&
    input.liveSitemap.status >= 200 &&
    input.liveSitemap.status < 400 &&
    input.liveSitemap.text.trim()
  ) {
    return true;
  }
  return input.files.some((row) => {
    const path = row.path.replace(/\\/g, '/');
    const content = row.content;
    return (
      /(?:^|\/)sitemap\.(xml|ts|js)$/i.test(path) ||
      /(?:^|\/)app\/sitemap\.(ts|js)$/i.test(path) ||
      /(?:^|\/)src\/app\/sitemap\.(ts|js)$/i.test(path) ||
      /@astrojs\/sitemap/.test(content) ||
      /integrations:\s*\[[\s\S]*sitemap\(/.test(content)
    );
  });
}

export function checkSitemap(input: SeoScanInput): SeoFinding[] {
  if (hasSitemap(input)) {
    return [
      finding({
        id: 'sitemap:present',
        category: 'sitemap',
        status: 'pass',
        title: 'Sitemap is present',
        detail:
          input.stack === 'NEXTJS'
            ? 'app/sitemap.ts (or a sitemap response) is present.'
            : 'A sitemap file or sitemap integration is present.',
        fixable: false,
      }),
    ];
  }

  const detail =
    input.stack === 'NEXTJS'
      ? 'Add app/sitemap.ts listing every public route.'
      : 'Add sitemap.xml listing every known public route.';

  return [
    finding({
      id: 'sitemap:missing',
      category: 'sitemap',
      status: 'medium',
      title: 'Sitemap is missing',
      detail,
    }),
  ];
}
