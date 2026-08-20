import type { StackId } from '@/lib/stacks';
import { PREVIEW_BASIC_USER } from './constants';

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
 * Both gates ask for the same account, `PREVIEW_BASIC_USER`. Traefik has always enforced
 * it on the static path; the middleware used to discard the username entirely, so one
 * feature answered two different questions depending on the stack (F-231).
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

  // Compose, never overwrite. A project's own middleware.ts (auth, redirects,
  // i18n) used to be replaced wholesale, so the deployed preview behaved
  // differently from the site the user was looking at, with no way to see why
  // (F-230). The project's middleware is moved to a sibling module and the
  // preview gate wraps it: the gate runs first (fail-closed), then the project's
  // middleware, then the noindex header is stamped on whatever comes back.
  const projectMwPath = findProjectMiddleware(next);
  if (projectMwPath) {
    const dir = projectMwPath.slice(0, projectMwPath.lastIndexOf('/') + 1);
    const ext = projectMwPath.slice(projectMwPath.lastIndexOf('.') + 1);
    const siblingPath = `${dir}middleware.project.${ext}`;
    next[siblingPath] = next[projectMwPath];
    next[projectMwPath] = composedPreviewMiddleware(Boolean(input.passwordProtected));
  } else {
    next['middleware.ts'] = previewMiddlewareSource(Boolean(input.passwordProtected));
  }
  // The noindex header is the middleware's job now, set unconditionally on every
  // response. Patching an existing next.config to add a `headers()` block was
  // fragile string surgery whose old helper added only a comment (F-230); a
  // fresh config is written only when the project ships none, so nothing the
  // user wrote is rewritten.
  const hasConfig = Object.keys(next).some((path) =>
    /^next\.config\.(js|mjs|ts)$/.test(path.split('/').pop() || ''),
  );
  if (!hasConfig) {
    next['next.config.js'] =
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  poweredByHeader: false,\n  async headers() {\n    return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }];\n  },\n};\nmodule.exports = nextConfig;\n`;
  }
  return next;
}

/** The project's own Next middleware, root or under src/, or null. */
function findProjectMiddleware(files: Record<string, string>): string | null {
  for (const path of [
    'middleware.ts',
    'middleware.js',
    'middleware.mjs',
    'src/middleware.ts',
    'src/middleware.js',
    'src/middleware.mjs',
  ]) {
    if (path in files) return path;
  }
  return null;
}

function injectHtmlNoindex(content: string) {
  if (content.includes('name="robots"') || content.includes("name='robots'")) return content;
  if (/<\/head>/i.test(content)) {
    return content.replace(/<\/head>/i, `  ${NOINDEX_META}\n</head>`);
  }
  return `${NOINDEX_META}\n${content}`;
}

/**
 * The password gate, shared by the standalone and the composed middleware. The
 * `unauthorized` helper and the credential check are emitted only alongside the gate
 * that calls them, so an unreferenced function never trips lint in the user's own build.
 *
 * Fail closed: the gate branch is emitted only when `Deployment.passwordHash`
 * is set, so a missing `PREVIEW_PASSWORD` means the Coolify app lost the env
 * var — serving the preview open would be the exact hole the gate exists to
 * close.
 *
 * The comparison is constant-time by construction (F-231). It used to be
 * `password !== expected`, which stops at the first differing byte: over enough requests
 * that hands a remote attacker the password's length and then its prefix, and this gate is
 * the only thing in front of an unpublished site. Both sides are now reduced to a 32-byte
 * SHA-256 digest before `timingSafeEqual` sees them, so the lengths always match (it
 * throws on a mismatch) and nothing about the secret can be recovered from how long the
 * answer took.
 *
 * The username is checked too, against the same account Traefik enforces on the
 * static-stack preview. It used to be split off and discarded, so `anything:<password>`
 * opened the preview while the static stack demanded `preview` — one feature, two answers.
 *
 * The block is fenced with marker comments because `tests/unit/publish-preview-gate.test.ts`
 * lifts it out and runs it: this source ships to someone else's repository, so nothing here
 * would ever execute it otherwise, and a substring assertion cannot tell a working gate
 * from a broken one.
 */
function previewGateParts(withPassword: boolean): {
  imports: string;
  unauthorized: string;
  gate: string;
} {
  if (!withPassword) return { imports: '', unauthorized: '', gate: '' };
  return {
    imports: `import { createHash, timingSafeEqual } from 'node:crypto';\n`,
    unauthorized: `
function unauthorized() {
  return new NextResponse('Password required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Preview"',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
// navroop-preview-auth:start
const PREVIEW_USER = ${JSON.stringify(PREVIEW_BASIC_USER)};

function previewCredentialsOk(header: string | null, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  const [scheme, encoded] = (header || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // Both digests are computed before either result is inspected, so a wrong username
  // costs a request exactly as much as a wrong password.
  const userOk = timingSafeEqual(digest(user), digest(PREVIEW_USER));
  const passwordOk = timingSafeEqual(digest(password), digest(expected));
  return userOk && passwordOk;
}
// navroop-preview-auth:end
`,
    gate: `
  const expected = process.env.PREVIEW_PASSWORD;
  if (!expected) return unauthorized();
  if (!previewCredentialsOk(request.headers.get('authorization'), expected)) {
    return unauthorized();
  }
`,
  };
}

/**
 * `runtime: 'nodejs'` is what makes `node:crypto` reachable: middleware still defaults to
 * the Edge runtime in Next 16, where the import does not resolve and the generated project
 * fails to build. It is pinned only when the gate is emitted, so an unprotected preview
 * keeps whatever runtime Next picks.
 */
function previewConfig(withPassword: boolean) {
  return `export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],${withPassword ? `\n  runtime: 'nodejs',` : ''}
};
`;
}

function previewMiddlewareSource(withPassword: boolean) {
  const { imports, unauthorized, gate } = previewGateParts(withPassword);
  return `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
${imports}${unauthorized}
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
${gate}  return response;
}

${previewConfig(withPassword)}`;
}

/**
 * Wraps the project's own middleware (moved to `./middleware.project`) rather
 * than replacing it (F-230). The gate runs first and fail-closed, so an
 * unauthenticated request is refused before any project code runs; then the
 * project's middleware runs and its result (a redirect, a rewrite, or a plain
 * next) is returned with the noindex header stamped on. Namespace import
 * because a project may export `middleware` or a `default`.
 */
function composedPreviewMiddleware(withPassword: boolean) {
  const { imports, unauthorized, gate } = previewGateParts(withPassword);
  return `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as projectMiddleware from './middleware.project';
${imports}${unauthorized}
type ProjectHandler = (
  request: NextRequest,
) => Response | Promise<Response | undefined> | undefined | void;

export async function middleware(request: NextRequest) {
${gate}  const mod = projectMiddleware as { middleware?: ProjectHandler; default?: ProjectHandler };
  const run = mod.middleware ?? mod.default;
  const result = run ? await run(request) : undefined;
  const response = result ?? NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

${previewConfig(withPassword)}`;
}
