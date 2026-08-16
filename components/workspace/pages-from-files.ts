import type { WorkspacePage } from './types';

function titleCaseSegment(segment: string) {
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function addPage(pages: WorkspacePage[], seen: Set<string>, path: string, label: string) {
  if (seen.has(path)) return;
  seen.add(path);
  pages.push({ path, label });
}

/**
 * Derive preview routes from the existing sandbox/generation file list.
 * Root / index / app/page = Homepage. Not a new data model.
 */
export function pagesFromFiles(paths: string[]): WorkspacePage[] {
  const pages: WorkspacePage[] = [];
  const seen = new Set<string>();
  addPage(pages, seen, '/', 'Homepage');

  for (const raw of paths) {
    const file = raw.replace(/\\/g, '/').replace(/^\.\//, '');

    const appIndex = /(?:^|\/)app\/page\.(tsx|jsx|js|mdx)$/.test(file);
    if (appIndex) continue;

    const appRoute = file.match(/(?:^|\/)app\/(.+)\/page\.(tsx|jsx|js|mdx)$/);
    if (appRoute?.[1] && !appRoute[1].startsWith('(')) {
      const path = `/${appRoute[1].replace(/\/\([^)]+\)/g, '').replace(/^\//, '')}`;
      addPage(pages, seen, path, titleCaseSegment(appRoute[1].split('/').pop() || path));
      continue;
    }

    const svelteIndex = /(?:^|\/)routes\/\+page\.(svelte|js|ts)$/.test(file);
    if (svelteIndex) continue;

    const svelteRoute = file.match(/(?:^|\/)routes\/(.+)\/\+page\.(svelte|js|ts)$/);
    if (svelteRoute?.[1]) {
      const path = `/${svelteRoute[1]}`;
      addPage(pages, seen, path, titleCaseSegment(svelteRoute[1].split('/').pop() || path));
      continue;
    }

    const astroIndex = /(?:^|\/)pages\/index\.(astro|html)$/.test(file);
    if (astroIndex) continue;

    const astroPage = file.match(/(?:^|\/)pages\/(.+)\.(astro|html)$/);
    if (astroPage?.[1] && astroPage[1] !== 'index') {
      const path = `/${astroPage[1].replace(/\/index$/, '')}`;
      addPage(pages, seen, path, titleCaseSegment(astroPage[1].split('/').pop() || path));
      continue;
    }

    const html = file.match(/(?:^|\/)([^/]+)\.html$/);
    if (html?.[1] && html[1] !== 'index' && !file.includes('/')) {
      addPage(pages, seen, `/${html[1]}.html`, titleCaseSegment(html[1]));
    }
  }

  return pages;
}
