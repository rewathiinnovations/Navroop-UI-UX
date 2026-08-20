export function previewResponseHeaders(input: {
  appOrigin: string;
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
    // No `X-Frame-Options`. The only value that expressed this intent,
    // `ALLOW-FROM <origin>`, was legacy-IE-only and is out of the spec, so every
    // current browser ignores the header when it sees it (F-150) — it read as a
    // second layer of protection that does not exist. `frame-ancestors` above is
    // the control. `SAMEORIGIN` is not a fallback here: the preview host is
    // deliberately not the app origin, so it would forbid the one framing the
    // product needs.
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  // Always `no-store`. Nothing served from a preview build is content-addressed
  // — `lib/preview/bundle.ts` writes a fixed `preview.js` — so there is no path
  // that may be pinned, and `index.html` least of all. This used to be decided
  // by `prefix.includes(prefix.split('/').pop())`, true of every string, which
  // marked every 200 immutable for a year (F-149); it was masked only by the
  // token query varying the cache key.
  headers['Cache-Control'] = 'private, no-store';
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
