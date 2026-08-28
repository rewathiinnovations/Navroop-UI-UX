/**
 * Page paths the proxy lets through without a session. `/api` and
 * `/preview-static` use `PUBLIC_API_ROUTES` instead. A page added tomorrow
 * is private until it is listed here.
 */
export const PUBLIC_PAGES = new Set(['/', '/login', '/signup', '/preview-view']);

export function isPublicPage(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PUBLIC_PAGES.has(path);
}
