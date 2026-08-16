export type ExtractedDoc = {
  lang: string;
  viewport: string;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLd: Record<string, unknown>[];
  h1: string[];
  headings: string[];
  hasNav: boolean;
  hasMain: boolean;
  hasFooter: boolean;
};

function metaContent(html: string, name: string): string {
  const named = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
  );
  if (named?.[1]) return named[1].trim();
  const reversed = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'),
  );
  return reversed?.[1]?.trim() ?? '';
}

function allMeta(html: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta\b([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const tag = match[1];
    const key = /(?:name|property)=["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (!key || content == null) continue;
    if (key.toLowerCase().startsWith(prefix.toLowerCase())) {
      out[key.toLowerCase()] = content.trim();
    }
  }
  return out;
}

export function extractDocument(html: string): ExtractedDoc {
  const lang = /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1]?.trim() ?? '';
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const canonical =
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1]?.trim() ||
    /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html)?.[1]?.trim() ||
    '';

  const jsonLd: Record<string, unknown>[] = [];
  const ldRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld: RegExpExecArray | null;
  while ((ld = ldRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(ld[1]);
      if (Array.isArray(parsed)) jsonLd.push(...parsed.filter((item) => item && typeof item === 'object'));
      else if (parsed && typeof parsed === 'object') jsonLd.push(parsed);
    } catch {
      /* ignore invalid json-ld */
    }
  }

  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((row) =>
    row[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  );
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((row) => `h${row[1]}`);

  return {
    lang,
    viewport: metaContent(html, 'viewport'),
    title,
    description: metaContent(html, 'description'),
    canonical,
    robots: metaContent(html, 'robots'),
    og: allMeta(html, 'og:'),
    twitter: allMeta(html, 'twitter:'),
    jsonLd,
    h1,
    headings,
    hasNav: /<nav\b/i.test(html),
    hasMain: /<main\b/i.test(html),
    hasFooter: /<footer\b/i.test(html),
  };
}

const PLACEHOLDER =
  /^(home|page|untitled|lorem|ipsum|welcome to( my)? (site|website|app)|feature \d+|todo|tbd|placeholder)$/i;

export function isPlaceholderText(value: string): boolean {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return true;
  return PLACEHOLDER.test(cleaned) || /lorem ipsum/i.test(cleaned);
}

export function jsonLdTypes(nodes: Record<string, unknown>[]): string[] {
  const types: string[] = [];
  for (const node of nodes) {
    const raw = node['@type'];
    if (typeof raw === 'string') types.push(raw);
    else if (Array.isArray(raw)) types.push(...raw.filter((item): item is string => typeof item === 'string'));
    const graph = node['@graph'];
    if (Array.isArray(graph)) {
      types.push(...jsonLdTypes(graph.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')));
    }
  }
  return types;
}

export function fileText(files: { path: string; content: string }[], test: (path: string) => boolean): string {
  return files
    .filter((file) => test(file.path.replace(/\\/g, '/')))
    .map((file) => file.content)
    .join('\n');
}
