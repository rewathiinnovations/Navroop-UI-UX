export function previewResponseHeaders(input: {
  appOrigin: string;
  cacheImmutable?: boolean;
  contentType?: string;
  contentEncoding?: string;
}) {
  // No 'unsafe-eval': nothing in the served document needs it — esbuild's esm
  // output, the shims in lib/preview/html.ts and the Tailwind Play CDN script
  // are all eval-free (verified against the fetched CDN bundle). The explicit
  // script hosts are the two the built document loads (lib/preview/deps.ts,
  // lib/stack-prompts/static-html.ts); fonts.googleapis.com is what the design
  // briefs import (lib/ui-ux-pro-max/build-design-brief.ts).
  const headers: Record<string, string> = {
    'Content-Security-Policy': [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://esm.sh`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `img-src 'self' data: https:`,
      `font-src 'self' data: https:`,
      `frame-ancestors 'self' ${input.appOrigin}`,
    ].join('; '),
    'X-Frame-Options': `ALLOW-FROM ${input.appOrigin}`,
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (input.cacheImmutable) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'private, no-store';
  }
  if (input.contentType) headers['Content-Type'] = input.contentType;
  if (input.contentEncoding) headers['Content-Encoding'] = input.contentEncoding;
  return headers;
}

export function appOriginFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw =
    env.APP_URL ||
    env.NEXTAUTH_URL ||
    env.AUTH_URL ||
    env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}
