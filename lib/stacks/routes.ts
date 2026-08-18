import { getStack } from '@/lib/stacks';
import type { FileInfo, RouteInfo } from '@/types/file-manifest';

/**
 * Extract routes using each stack's filesystem / router conventions.
 * Registry-driven via getStack() — no silent React Router fallback.
 */
export function extractStackRoutes(stack: string, files: Record<string, FileInfo>): RouteInfo[] {
  const id = getStack(stack).id;
  switch (id) {
    case 'REACT':
      return extractReactRouterRoutes(files);
    case 'NEXTJS':
      return extractNextAppRoutes(files);
    case 'STATIC_HTML':
      return extractStaticHtmlRoutes(files);
    default: {
      const _exhaustive: never = id;
      throw new Error(`Missing route extractor for "${_exhaustive}"`);
    }
  }
}

function normalizeRel(file: FileInfo): string {
  return (file.relativePath || file.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function dynamicToParam(segment: string): string {
  const bracket = segment.match(/^\[(\.\.\.)?([^\]]+)\]$/);
  if (!bracket) return segment;
  return bracket[1] ? `*${bracket[2]}` : `:${bracket[2]}`;
}

/** Existing Open Lovable React Router + pages/ extraction. */
export function extractReactRouterRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const [path, fileInfo] of Object.entries(files)) {
    if (fileInfo.content.includes('<Route') || fileInfo.content.includes('createBrowserRouter')) {
      const routeMatches = fileInfo.content.matchAll(
        /path=["']([^"']+)["'].*(?:element|component)={([^}]+)}/g,
      );

      for (const match of routeMatches) {
        const [, routePath] = match;
        routes.push({
          path: routePath,
          component: path,
        });
      }
    }

    if (
      fileInfo.relativePath.startsWith('pages/') ||
      fileInfo.relativePath.startsWith('src/pages/')
    ) {
      const routePath =
        '/' +
        fileInfo.relativePath
          .replace(/^(src\/)?pages\//, '')
          .replace(/\.(jsx?|tsx?)$/, '')
          .replace(/index$/, '');

      routes.push({
        path: routePath,
        component: path,
      });
    }
  }

  return routes;
}

function extractNextAppRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);
    const pageMatch = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(tsx|ts|jsx|js)$/);
    if (!pageMatch) continue;
    const segments = (pageMatch[1] || '')
      .split('/')
      .filter(Boolean)
      .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
      .map(dynamicToParam);
    routes.push({
      path: '/' + segments.join('/'),
      component: path,
    });
  }
  return routes;
}

function extractStaticHtmlRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);
    if (!rel.endsWith('.html')) continue;
    const withoutExt = rel
      .replace(/\.html$/, '')
      .replace(/\/index$/, '')
      .replace(/^index$/, '');
    routes.push({
      path: '/' + withoutExt,
      component: path,
    });
  }
  return routes;
}
