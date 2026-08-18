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
    return { status: 404, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }, body: NOT_FOUND_HTML };
  }

  const relative = resolvePreviewObjectPath(input.path, {
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
