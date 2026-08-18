export function previewResponseHeaders(input: {
  appOrigin: string;
  cacheImmutable?: boolean;
  contentType?: string;
  contentEncoding?: string;
}) {
  const headers: Record<string, string> = {
    'Content-Security-Policy': `frame-ancestors 'self' ${input.appOrigin}; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; img-src 'self' data: blob: https:; font-src 'self' data: https:`,
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
