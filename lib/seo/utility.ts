const UTILITY_SEGMENT =
  /^(dashboard|dash|admin|login|signin|signup|register|settings|account|billing|app|apps|tools|tool|console|internal|auth)$/i;

export function isUtilityRoute(path: string): boolean {
  const clean = path.split('?')[0].split('#')[0].replace(/\\/g, '/');
  const parts = clean.split('/').filter(Boolean);
  return parts.some((part) => UTILITY_SEGMENT.test(part));
}

export function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    const path = url.split('?')[0] || '/';
    return path.startsWith('/') ? path : `/${path}`;
  }
}
