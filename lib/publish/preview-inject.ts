import type { StackId } from '@/lib/stacks';

const NOINDEX_META = '<meta name="robots" content="noindex, nofollow" />';
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/**
 * Preview password + noindex are injected into the files pushed to the deploy
 * repo only — never written back to the sandbox.
 *
 * Password gate:
 * - static stacks (HTML/Vite/Astro/Vue/Svelte): Coolify Traefik basic auth
 *   (`is_http_basic_auth_enabled` on the application). No file-level gate.
 * - node stacks (NEXTJS): Next.js middleware Basic Auth against PREVIEW_PASSWORD
 *   plus X-Robots-Tag. The bcrypt hash stays on `Deployment.passwordHash`; the plain
 *   password lives only as a Coolify env var on the application, written by
 *   `updatePreviewPassword`.
 *
 * `passwordProtected` is a flag, not the secret: the plaintext must never reach the
 * deploy repo. It is derived from `Deployment.passwordHash`, so a plain re-publish
 * cannot silently drop a gate the user set earlier — which is exactly what happened
 * while the only caller hardcoded `password: null` and the UI still reported
 * `hasPassword: true`.
 */
export function injectPreviewFiles(
  files: Record<string, string>,
  input: { stack: StackId; deployType: 'static' | 'node'; passwordProtected?: boolean },
) {
  const next = { ...files };

  if (input.deployType === 'static') {
    next['robots.txt'] = ROBOTS_TXT;
    for (const [path, content] of Object.entries(next)) {
      if (!/\.html?$/i.test(path)) continue;
      next[path] = injectHtmlNoindex(content);
    }
    return next;
  }

  next['middleware.ts'] = previewMiddlewareSource(Boolean(input.passwordProtected));
  const configPath = Object.keys(next).find((path) =>
    /^next\.config\.(js|mjs|ts)$/.test(path.split('/').pop() || ''),
  );
  if (configPath) {
    next[configPath] = ensureNextNoindexHeaders(next[configPath]);
  } else {
    next['next.config.js'] =
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  poweredByHeader: false,\n  async headers() {\n    return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }];\n  },\n};\nmodule.exports = nextConfig;\n`;
  }
  return next;
}

function injectHtmlNoindex(content: string) {
  if (content.includes('name="robots"') || content.includes("name='robots'")) return content;
  if (/<\/head>/i.test(content)) {
    return content.replace(/<\/head>/i, `  ${NOINDEX_META}\n</head>`);
  }
  return `${NOINDEX_META}\n${content}`;
}

function ensureNextNoindexHeaders(source: string) {
  if (source.includes('X-Robots-Tag')) return source;
  return `${source.trim()}\n\n// navroop-preview-noindex: add X-Robots-Tag via middleware.ts\n`;
}

function previewMiddlewareSource(withPassword: boolean) {
  // Emitted with the gate and only with the gate: an unreferenced helper trips lint in the
  // generated project, and the build there is the user's, not ours.
  const unauthorized = withPassword
    ? `
function unauthorized() {
  return new NextResponse('Password required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Preview"',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
`
    : '';
  // Fail closed. This branch is only emitted when Deployment.passwordHash is set, so a
  // missing PREVIEW_PASSWORD means the Coolify application lost the env var — serving the
  // preview open would be the exact hole the gate exists to close.
  const gate = withPassword
    ? `
  const expected = process.env.PREVIEW_PASSWORD;
  if (!expected) return unauthorized();
  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return unauthorized();
  const decoded = atob(encoded);
  const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
  if (password !== expected) return unauthorized();
`
    : '';
  return `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
${unauthorized}
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
${gate}  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
`;
}
