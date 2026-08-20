import type { SeoScanInput } from './types';

type SourceFile = SeoScanInput['files'][number];

/**
 * Where a document-level concern is allowed to be declared.
 *
 * Several checks used to pass if a substring appeared anywhere in the whole
 * repository concatenated together — `/viewport/i` over every file, `/og:title/`
 * over every file, `rel="canonical"` over every file. A CSS comment mentioning
 * "viewport", or the literal `og:title` inside a helper that builds meta tags,
 * satisfied them, so the SEO score was built from systematic false passes
 * (F-731). Each check now looks only at the files that can actually own the
 * concern, and reports "could not determine" when none of them exist.
 */
export type ScopedVerdict = boolean | null;

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

/** The root document: the shell that owns `<html>`, viewport and site-wide meta. */
export function rootDocumentFiles(files: SourceFile[]): SourceFile[] {
  return files.filter((file) => {
    const path = normalize(file.path);
    return (
      /(^|\/)index\.html?$/i.test(path) ||
      /(^|\/)(src\/)?app\/layout\.(t|j)sx$/.test(path) ||
      /(^|\/)(src\/)?pages\/_(document|app)\.(t|j)sx$/.test(path) ||
      /(^|\/)(src\/)?app\.html$/i.test(path)
    );
  });
}

/**
 * Files that may declare per-route metadata: the root document plus route
 * entrypoints (Next `page`/`layout`, Vite/CRA pages, SvelteKit/Astro routes).
 */
export function metadataFiles(files: SourceFile[]): SourceFile[] {
  const roots = rootDocumentFiles(files);
  const routes = files.filter((file) => {
    const path = normalize(file.path);
    return (
      /(^|\/)(src\/)?app\/(.*\/)?(page|layout|head)\.(t|j)sx$/.test(path) ||
      /(^|\/)(src\/)?pages\/.+\.(t|j)sx$/.test(path) ||
      /(^|\/)src\/(pages|routes)\/.+\.(astro|vue|svelte)$/.test(path) ||
      /\.html?$/i.test(path)
    );
  });
  return [...new Set([...roots, ...routes])];
}

/**
 * `true` when at least one scoped file declares it, `false` when scoped files
 * exist and none do, `null` when there is no file that could own the concern —
 * which is a gap in what we can see, not a defect in the project.
 */
export function scopedVerdict(scoped: SourceFile[], declares: RegExp): ScopedVerdict {
  if (scoped.length === 0) return null;
  return scoped.some((file) => declares.test(file.content));
}

/** `<meta name="viewport">`, or Next's `viewport` metadata export. */
export const VIEWPORT_DECLARATION =
  /<meta[^>]+name=["']viewport["']|export\s+const\s+viewport\b|\bviewport\s*:\s*[{'"`]/;

/** `<link rel="canonical">`, or a `canonical` inside a Next `alternates` block. */
export const CANONICAL_DECLARATION =
  /<link[^>]+rel=["']canonical["']|alternates\s*:\s*\{[\s\S]{0,400}?canonical/;

export function openGraphDeclaration(property: string): RegExp {
  // Raw meta tags name the property; Next's metadata object nests the field
  // under `openGraph`, where the `og:` prefix never appears.
  // `images`, not `image`, is what Next's `openGraph` object calls it.
  const field = property.replace(/^og:/, '');
  return new RegExp(
    `(?:name|property)=["']${property}["']|openGraph\\s*:\\s*\\{[\\s\\S]{0,600}?\\b${field}s?\\s*:`,
  );
}
