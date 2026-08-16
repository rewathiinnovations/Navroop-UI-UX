import { extractDocument, jsonLdTypes } from '../html';
import { finding } from '../findings';
import { isUtilityRoute, pathFromUrl } from '../utility';
import type { SeoFinding, SeoScanInput } from '../types';

function typesFromFiles(files: SeoScanInput['files']): string[] {
  const types: string[] = [];
  for (const file of files) {
    if (isUtilityRoute(file.path)) continue;
    const matches = file.content.matchAll(/"@type"\s*:\s*"([^"]+)"/g);
    for (const match of matches) types.push(match[1]);
  }
  return types;
}

export function checkStructuredData(input: SeoScanInput): SeoFinding[] {
  const livePath = input.live?.url ? pathFromUrl(input.live.url) : '/';
  if (isUtilityRoute(livePath)) return [];

  const publicFiles = input.files.filter((file) => !isUtilityRoute(file.path));
  const doc = extractDocument(input.live?.html || '');
  const types = [...jsonLdTypes(doc.jsonLd), ...typesFromFiles(publicFiles)].map((type) => type.toLowerCase());
  const hasOrg = types.some((type) => type === 'organization' || type === 'localbusiness');
  const hasSite = types.some((type) => type === 'website');
  const hasAny = types.length > 0;

  if (hasOrg && hasSite) {
    return [
      finding({
        id: 'structured-data:home',
        category: 'structured-data',
        status: 'pass',
        title: 'Home JSON-LD matches purpose',
        detail: 'Organization and WebSite structured data are present.',
        fixable: false,
      }),
    ];
  }

  if (hasAny) {
    return [
      finding({
        id: 'structured-data:home',
        category: 'structured-data',
        status: 'low',
        title: 'JSON-LD is present but incomplete for home',
        detail: `Found ${[...new Set(types)].join(', ')}. Home should include Organization and WebSite. Omit JSON-LD on dashboards and tools.`,
      }),
    ];
  }

  return [
    finding({
      id: 'structured-data:home',
      category: 'structured-data',
      status: 'medium',
      title: 'JSON-LD is missing on the public home page',
      detail: 'Add Organization and WebSite JSON-LD on home. Use Article, Product, or BreadcrumbList on matching public pages. Skip utility and dashboard routes.',
    }),
  ];
}
