/**
 * Turn a raw `<img>` into `next/image` on the Next.js stack.
 *
 * ## Why a transform rather than another rule
 *
 * The prompt has told the model to use `next/image` on this stack for a long
 * time, in the IMAGES section of `lib/stack-prompts/base-rules.ts`, and the rule
 * was sharpened again when this was written. Across generations the model still
 * emits `<img>`: six of nineteen files in one measured build, none of them using
 * `next/image` at all. A rule that is ignored every time is not a rule, and the
 * cost is real on the published site — no responsive `srcset`, no format
 * negotiation, and layout shift on every photograph.
 *
 * The conversion is mechanical, so it is done mechanically. `lib/preview/assemble.ts`
 * shims `next/image` as a plain `<img>` passthrough, so this can never change what
 * the preview shows; what it changes is the site the user exports, publishes and
 * deploys.
 *
 * ## What it refuses to touch
 *
 * `next/image` needs intrinsic dimensions. An `<img>` without both `width` and
 * `height`, or with a spread whose contents cannot be read (`{...props}`), is
 * left exactly as written and reported as an advisory instead — a converted
 * element that throws at runtime would be far worse than an unoptimised one.
 */

export type ImageConversion = { file: string; count: number };

const IMPORT_LINE = 'import Image from "next/image";';

/** `width={800}`, `width="800"`, `width={size}` — any form of the attribute. */
function hasAttribute(attributes: string, name: string): boolean {
  return new RegExp(`(^|\\s)${name}\\s*=`).test(attributes);
}

/**
 * The span of one JSX element starting at `<img`, or null when it does not end
 * where a self-closing element must.
 *
 * Scans rather than pattern-matches because an attribute value may contain `>`
 * (`className={cn("a>b")}` is legal, and a template literal can hold anything).
 * Quotes and braces are tracked so the terminator is the real one.
 */
function readElement(source: string, start: number): { end: number; attributes: string } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 4; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (depth === 0 && char === '>') {
      // Only a self-closing element. `<img>` without the slash is invalid JSX,
      // so if this is not `/>` the file will not compile and is not ours to fix.
      if (source[i - 1] !== '/') return null;
      return { end: i + 1, attributes: source.slice(start + 4, i - 1) };
    }
  }
  return null;
}

/**
 * Rewrite the attributes `next/image` spells differently.
 *
 * `loading="eager"` plus `fetchPriority="high"` is the raw-HTML spelling of
 * `priority`, which is the only one Next understands for preloading; leaving the
 * pair in place would keep the hero out of the preload scanner.
 */
function convertAttributes(attributes: string): string {
  let out = attributes;
  const eager = /(^|\s)loading\s*=\s*["']eager["']/.test(out);
  const highPriority = /(^|\s)fetchPriority\s*=\s*["']high["']/i.test(out);

  out = out.replace(/(^|\s)loading\s*=\s*["']eager["']/g, '$1');
  out = out.replace(/(^|\s)fetchPriority\s*=\s*["'][^"']*["']/gi, '$1');
  // `decoding` is a plain <img> attribute; next/image forwards unknown props, but
  // it has its own decoding behaviour and the attribute only adds noise.
  out = out.replace(/(^|\s)decoding\s*=\s*["'][^"']*["']/g, '$1');

  if (eager || highPriority) out = `${out.trimEnd()} priority`;
  return out;
}

function ensureImport(source: string): string {
  if (/import\s+\w+\s+from\s+["']next\/image["']/.test(source)) return source;
  // After the file's own directive prologue, if it has one: an import above
  // `"use client"` is a syntax error.
  const directive = /^\s*(['"])use (client|server)\1;?\s*\n/.exec(source);
  if (directive) {
    const at = directive[0].length;
    return `${source.slice(0, at)}${IMPORT_LINE}\n${source.slice(at)}`;
  }
  return `${IMPORT_LINE}\n${source}`;
}

/**
 * Convert every convertible `<img>` in a generated file map.
 *
 * Returns a new map (only changed files are replaced) and a per-file count, so
 * the chat can say what happened rather than silently changing the markup.
 */
export function fixNextImages(files: Record<string, string>): {
  files: Record<string, string>;
  conversions: ImageConversion[];
} {
  const conversions: ImageConversion[] = [];
  const next: Record<string, string> = { ...files };

  for (const [path, source] of Object.entries(files)) {
    if (typeof source !== 'string') continue;
    if (!/\.(tsx|jsx)$/.test(path)) continue;
    if (!source.includes('<img')) continue;

    let out = '';
    let cursor = 0;
    let converted = 0;
    let at = source.indexOf('<img');
    while (at !== -1) {
      const element = readElement(source, at);
      // `<image>` (SVG) starts with the same four characters; the next one has to
      // be whitespace or the self-closing slash for this to be the HTML element.
      const isImgTag = /[\s/]/.test(source[at + 4] ?? '');
      if (!element || !isImgTag) {
        at = source.indexOf('<img', at + 4);
        continue;
      }

      const { attributes, end } = element;
      const convertible =
        hasAttribute(attributes, 'width') &&
        hasAttribute(attributes, 'height') &&
        hasAttribute(attributes, 'src') &&
        !attributes.includes('...');
      if (!convertible) {
        at = source.indexOf('<img', end);
        continue;
      }

      out += source.slice(cursor, at);
      out += `<Image${convertAttributes(attributes)} />`;
      cursor = end;
      converted += 1;
      at = source.indexOf('<img', end);
    }

    if (converted === 0) continue;
    out += source.slice(cursor);
    next[path] = ensureImport(out);
    conversions.push({ file: path, count: converted });
  }

  return { files: next, conversions };
}

/** One chat line, or null when nothing was converted. */
export function describeImageConversions(conversions: readonly ImageConversion[]): string | null {
  if (conversions.length === 0) return null;
  const total = conversions.reduce((sum, entry) => sum + entry.count, 0);
  return `Converted ${total} raw <img> element${total === 1 ? '' : 's'} to next/image across ${conversions.length} file${conversions.length === 1 ? '' : 's'}, so the published site gets responsive sizes and no layout shift.`;
}
