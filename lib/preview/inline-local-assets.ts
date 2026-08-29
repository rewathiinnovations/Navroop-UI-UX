/**
 * Inline project images into the preview document when the app is on localhost.
 *
 * ## Why this exists
 *
 * `withResolvableAssetUrls` (lib/preview/assemble.ts) rewrites `/uploads/…` to an
 * absolute URL on the app origin, on the correct reasoning that a subresource
 * load is not subject to the same-origin policy — so the opaque-origin preview
 * frame may fetch an image from another origin. That is true, and it is why the
 * published and deployed previews show their pictures.
 *
 * It is not true of **loopback**. Chrome's Private Network Access treats a
 * document with an opaque origin as coming from the public address space, and it
 * blocks a public-to-local subresource request outright. Measured in the preview
 * frame, unchanged, in the same second:
 *
 *   https://esm.sh/favicon.ico                          -> loads
 *   http://127.0.0.1:3000/uploads/…/hero.webp           -> error
 *   the same URL with `allow-same-origin` on the frame  -> loads
 *
 * So every generated site previewed on a development machine renders with no
 * photographs at all: alt text where the hero should be, and a gallery section
 * that looks like the generator produced an empty grid. It is only ever seen
 * during development, which is exactly where the product is judged.
 *
 * `allow-same-origin` is not the fix — with `allow-scripts` it would hand
 * model-authored JavaScript this app's origin, storage and session (F-140). A
 * `data:` URI has no address space, so it is not a private-network request at
 * all, and it loads in the sandbox as it is. That is what this does.
 *
 * ## Only on loopback
 *
 * Production keeps the absolute-URL path untouched: it works there, and a
 * multi-megabyte base64 payload inside a `srcdoc` attribute is a real cost to
 * pay for nothing. This module is a development-only correction, and it says so
 * by refusing to run against any other kind of origin.
 */

/** Per-tab, keyed by absolute URL. A rebuild mid-stream must not refetch. */
const cache = new Map<string, string>();

/** Anything past this is left alone: base64 is 4/3 of the bytes, in an attribute. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** Total budget across one document, so a large gallery cannot wedge the tab. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Every `<origin>/uploads/…` reference in a compiled bundle or stylesheet.
 *
 * Deliberately narrow: only this app's own asset prefix, only on the origin the
 * page is served from. A model-authored absolute URL to anywhere else is left
 * exactly as written.
 */
function assetUrls(sources: readonly string[], origin: string): string[] {
  const prefix = `${origin}/uploads/`;
  const found = new Set<string>();
  // Scanned by index rather than by regex: the prefix is a URL built at runtime,
  // so a pattern would have to be escaped and this cannot be got subtly wrong.
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

async function toDataUri(url: string, budget: { left: number }): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > MAX_ASSET_BYTES || blob.size > budget.left) return null;

    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit on
    // anything above a few hundred kilobytes, which is most photographs.
    for (let i = 0; i < buffer.length; i += 8192) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    }
    const type = blob.type || 'application/octet-stream';
    const uri = `data:${type};base64,${btoa(binary)}`;
    budget.left -= blob.size;
    cache.set(url, uri);
    return uri;
  } catch {
    // A failed inline is the status quo, not a new failure: the absolute URL
    // stays, and the image is as broken as it was before.
    return null;
  }
}

/**
 * Replace this app's own asset URLs with `data:` URIs, in place, across every
 * source given. Returns the sources unchanged when there is nothing to do — the
 * origin is not loopback, there are no references, or every fetch failed.
 */
export async function inlineLoopbackAssets(
  sources: readonly string[],
  origin: string | null,
): Promise<string[]> {
  const list = [...sources];
  if (!origin || !isLoopbackOrigin(origin)) return list;

  const urls = assetUrls(list, origin);
  if (urls.length === 0) return list;

  const budget = { left: MAX_TOTAL_BYTES };
  const replacements = new Map<string, string>();
  // Sequential rather than parallel: these are same-origin reads off a dev
  // server that is also compiling the app, and twelve concurrent image fetches
  // measurably delay the very build whose output is being previewed.
  for (const url of urls) {
    const uri = await toDataUri(url, budget);
    if (uri) replacements.set(url, uri);
  }
  if (replacements.size === 0) return list;

  return list.map((source) => {
    let next = source;
    for (const [url, uri] of replacements) next = next.split(url).join(uri);
    return next;
  });
}
