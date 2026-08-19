import { PREVIEW_NOT_FOUND_TITLE } from './labels';
import { appOriginFromEnv, previewResponseHeaders } from './headers';
import { resolvePreviewObjectPath } from './path';
import { verifyPreviewToken } from './token';
import { contentTypeForPath } from './mime';

export type ActivePreviewBuild = {
  storagePrefix: string;
  entryPath: string;
  isSpa: boolean;
};

export type PreviewServeResult = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
};

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${PREVIEW_NOT_FOUND_TITLE}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f4f1; color: #1f1b16; }
    main { text-align: center; padding: 24px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
    p { margin: 0; color: #6b645c; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>${PREVIEW_NOT_FOUND_TITLE}</h1>
    <p>This preview page does not exist.</p>
  </main>
</body>
</html>`;

/**
 * The request path becomes part of a storage key, so it must not be able to walk
 * out of `previews/{projectId}/{buildId}`. This route is public — a share link is
 * opened by people without an account — and before this guard
 * `GET /preview-static/{pid}/%2e%2e%2f%2e%2e%2f%2e%2e%2fsnapshots%2f{other}/{cp}.json.gz`
 * returned another project's whole source snapshot.
 *
 * The path as received is checked, and so is every percent-decoding round of it:
 * Next hands encoded `%2e%2e%2f` over as `../` while collapsing plain `..`, so the
 * encoded form is the one that arrives here, and a proxy that decodes one round
 * differently must not reopen the hole. Decoding stops at a malformed escape
 * rather than refusing the request, because a filename may legitimately contain a
 * bare `%` and the raw form — the one that becomes the key — is already checked.
 *
 * The leading slash is stripped once, up front. The route builds its path as
 * `/${segments.join('/')}`, so that slash is this function's own caller rather
 * than anything a visitor sent — and rejecting it as "absolute" 404'd every
 * preview that has ever been served, entry page included, while the tests stayed
 * green because they all passed the unprefixed form. A slash that appears only
 * after decoding is NOT stripped: there it does mean an absolute path.
 *
 * Returns null when the path escapes the prefix — the caller answers 404 rather
 * than confirming which of the two situations it hit.
 */
export function safePreviewRequestPath(requestPath: string): string | null {
  const raw = String(requestPath).replace(/\\/g, '/').replace(/^\/+/, '');
  for (const candidate of decodeRounds(raw)) {
    if (escapesPrefix(candidate)) return null;
  }
  return resolveSegments(raw);
}

function decodeRounds(path: string) {
  const rounds = [path];
  let current = path;
  // Three is past anything legitimate; a deeper encoding still only ever resolves
  // to a literal segment name, which cannot leave the prefix.
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
    rounds.push(current);
  }
  return rounds;
}

function escapesPrefix(path: string) {
  const unified = path.replace(/\\/g, '/');
  if (unified.includes('\0')) return true;
  if (unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified)) return true;
  let depth = 0;
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth < 0) return true;
  }
  return false;
}

function resolveSegments(path: string) {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export async function handlePreviewRequest(input: {
  projectId: string;
  path: string;
  token: string | null;
  appOrigin: string;
  secret: string;
  now: number;
  loadBuild: () => Promise<ActivePreviewBuild | null>;
  getObject: (key: string) => Promise<Buffer | null>;
}): Promise<PreviewServeResult> {
  const headers = previewResponseHeaders({
    appOrigin: input.appOrigin,
    cacheImmutable: false,
    contentType: 'text/plain; charset=utf-8',
  });
  const verified = verifyPreviewToken(input.token, {
    secret: input.secret,
    now: input.now,
    projectId: input.projectId,
  });
  if (!verified.ok) {
    return { status: 403, headers, body: 'Forbidden' };
  }

  const build = await input.loadBuild();
  if (!build?.storagePrefix) {
    return {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      body: NOT_FOUND_HTML,
    };
  }

  const safePath = safePreviewRequestPath(input.path);
  if (safePath === null) {
    return {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      body: NOT_FOUND_HTML,
    };
  }

  const relative = resolvePreviewObjectPath(safePath, {
    spaFallback: build.isSpa,
    entryPath: build.entryPath,
  });
  const key = `${build.storagePrefix.replace(/\/+$/, '')}/${relative}`;
  const object = await input.getObject(key);
  if (!object) {
    return {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      body: NOT_FOUND_HTML,
    };
  }

  return {
    status: 200,
    headers: previewResponseHeaders({
      appOrigin: input.appOrigin,
      cacheImmutable: build.storagePrefix.includes(build.storagePrefix.split('/').pop() || ''),
      contentType: contentTypeForPath(relative),
    }),
    body: object,
  };
}

export function previewNotFoundPage() {
  return NOT_FOUND_HTML;
}

export function previewAppOrigin() {
  return appOriginFromEnv();
}
