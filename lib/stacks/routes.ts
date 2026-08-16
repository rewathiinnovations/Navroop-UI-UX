import { getStack } from '@/lib/stacks';
import type { FileInfo, RouteInfo } from '@/types/file-manifest';

/**
 * Extract routes using each stack's filesystem / router conventions.
 * Registry-driven via getStack() — no silent React Router fallback.
 */
export function extractStackRoutes(
  stack: string,
  files: Record<string, FileInfo>,
): RouteInfo[] {
  const id = getStack(stack).id;
  switch (id) {
    case 'REACT':
      return extractReactRouterRoutes(files);
    case 'NEXTJS':
      return extractNextAppRoutes(files);
    case 'ASTRO':
      return extractAstroRoutes(files);
    case 'VUE':
      return extractVueRoutes(files);
    case 'SVELTE':
      return extractSvelteKitRoutes(files);
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

function extractAstroRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);
    const match = rel.match(/^(?:src\/)?pages\/(.+)\.(astro|md|mdx)$/);
    if (!match) continue;
    const withoutExt = match[1].replace(/\/index$/, '').replace(/^index$/, '');
    const segments = withoutExt.split('/').filter(Boolean).map(dynamicToParam);
    routes.push({
      path: '/' + segments.join('/'),
      component: path,
    });
  }
  return routes;
}

function extractSvelteKitRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);
    const match = rel.match(/^src\/routes\/(?:(.*)\/)?\+page\.(svelte|ts|js)$/);
    if (!match) continue;
    const segments = (match[1] || '')
      .split('/')
      .filter(Boolean)
      .map(dynamicToParam);
    routes.push({
      path: '/' + segments.join('/'),
      component: path,
    });
  }
  return routes;
}

function extractVueRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);

    if (file.content.includes('createRouter') || file.content.includes('vue-router')) {
      const matches = file.content.matchAll(/path:\s*['"]([^'"]+)['"]/g);
      for (const match of matches) {
        routes.push({ path: match[1], component: path });
      }
    }

    const pageMatch = rel.match(/^src\/(?:pages|views)\/(.+)\.vue$/);
    if (pageMatch) {
      const withoutIndex = pageMatch[1].replace(/\/index$/, '').replace(/^index$/, '');
      const segments = withoutIndex.split('/').filter(Boolean).map(dynamicToParam);
      routes.push({
        path: '/' + segments.join('/'),
        component: path,
      });
    }
  }

  return routes;
}

function extractStaticHtmlRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const [path, file] of Object.entries(files)) {
    const rel = normalizeRel(file);
    if (!rel.endsWith('.html')) continue;
    const withoutExt = rel.replace(/\.html$/, '').replace(/\/index$/, '').replace(/^index$/, '');
    routes.push({
      path: '/' + withoutExt,
      component: path,
    });
  }
  return routes;
}
