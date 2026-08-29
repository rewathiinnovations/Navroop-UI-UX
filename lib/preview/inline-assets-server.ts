import { get } from '@/lib/storage';
import { appOriginFromEnv } from './headers';
import { isLoopbackUrl } from './loopback';
import { contentTypeForPath } from './mime';

/**
 * Inline project images into a *stored* preview build when the app is on
 * loopback — the server-side twin of `lib/preview/inline-local-assets.ts`.
 *
 * The static build's markup carries this app's asset URLs rewritten absolute
 * against the app origin (`withResolvableAssetUrls`), which is correct in
 * production: the public shell's sandboxed iframe has an opaque origin, an
 * opaque origin counts as *public* address space, and a public document may
 * fetch a public https image. On a development machine the same fetch is
 * public→local, which Chrome's Private Network Access blocks outright — so a
 * locally served build rendered every photograph as alt text while the built
 * document was byte-for-byte fine.
 *
 * A `data:` URI has no address space. The bytes come straight from the storage
 * driver — this code runs where the driver lives, so unlike the browser-side
 * inliner there is no fetch to be blocked and no dependency on `.localhost`
 * resolving in Node.
 *
 * Bounded like the browser inliner, and loopback-only: a production build keeps
 * absolute URLs, which work there and keep the stored build small.
 */

/** Anything past this stays a URL: base64 is 4/3 of the bytes, in a stored file. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** Total budget per build, so a big gallery cannot balloon the stored site. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/** Files worth scanning: markup and the compiled bundle. Images are opaque. */
const TEXT_FILE = /\.(html|htm|js|mjs|css)$/i;

function assetReferences(sources: readonly string[], origin: string): string[] {
  const prefix = `${origin}/uploads/`;
  const found = new Set<string>();
  const ends = new Set([' ', '\t', '\n', '\r', '"', "'", '`', ')', ',', '<', '>', '\\', '{']);
  for (const source of sources) {
    let at = source.indexOf(prefix);
    while (at !== -1) {
      let end = at + prefix.length;
      while (end < source.length && !ends.has(source[end])) end += 1;
      found.add(source.slice(at, end));
      at = source.indexOf(prefix, end);
    }
  }
  return [...found];
}

/**
 * Replace `<appOrigin>/uploads/…` references with data URIs across a built file
 * map. Returns the same map instance when there is nothing to do — not on
 * loopback, no references, or nothing readable.
 */
export async function inlineLoopbackAssetsIntoBuild(
  files: Record<string, string>,
  appOrigin: string = appOriginFromEnv(),
): Promise<Record<string, string>> {
  if (!isLoopbackUrl(appOrigin)) return files;
  const origin = appOrigin.replace(/\/+$/, '');

  const textEntries = Object.entries(files).filter(([path]) => TEXT_FILE.test(path));
  const sources = textEntries.map(([, body]) => body);
  const urls = assetReferences(sources, origin);
  if (urls.length === 0) return files;

  let budget = MAX_TOTAL_BYTES;
  const replacements = new Map<string, string>();
  for (const url of urls) {
    // `/uploads/{key}` is the local driver's URL shape (`localUrl` in
    // lib/storage/index.ts), so the storage key is everything after it.
    const key = decodeURIComponent(url.slice(`${origin}/uploads/`.length));
    if (!key) continue;
    let body: Buffer | null = null;
    try {
      body = await get(key);
    } catch {
      body = null;
    }
    // Unreadable or oversized stays a URL: the image is as absent as it was,
    // and the page still renders around it.
    if (!body || body.length > MAX_ASSET_BYTES || body.length > budget) continue;
    budget -= body.length;
    replacements.set(url, `data:${contentTypeForPath(key)};base64,${body.toString('base64')}`);
  }
  if (replacements.size === 0) return files;

  const out: Record<string, string> = { ...files };
  for (const [path, body] of textEntries) {
    let text = body;
    for (const [url, uri] of replacements) {
      if (text.includes(url)) text = text.split(url).join(uri);
    }
    if (text !== body) out[path] = text;
  }
  return out;
}
