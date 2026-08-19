export const NEED_IMAGE_ASPECTS = ['16:9', '1:1', '4:5', '1200x630'] as const;
export type NeedImageAspect = (typeof NEED_IMAGE_ASPECTS)[number];

export type NeedImageDirective = {
  token: string;
  description: string;
  aspect: NeedImageAspect;
};

const DIRECTIVE_RE =
  /NEED_IMAGE:\s*([^|\n<"']+?)(?:\s*\|\s*(16:9|1:1|4:5|1200x630))?(?=["'<\n]|$)/gi;

function normalizeAspect(value?: string | null): NeedImageAspect {
  if (value === '1:1' || value === '4:5' || value === '1200x630' || value === '16:9') {
    return value;
  }
  return '16:9';
}

export function parseNeedImageDirectives(text: string): NeedImageDirective[] {
  const found: NeedImageDirective[] = [];
  const seen = new Set<string>();
  const re = new RegExp(DIRECTIVE_RE.source, DIRECTIVE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const description = match[1].replace(/\s+/g, ' ').trim();
    if (!description) continue;
    const aspect = normalizeAspect(match[2]);
    const token = match[2]
      ? `NEED_IMAGE: ${description} | ${aspect}`
      : `NEED_IMAGE: ${description}`;
    const key = `${description.toLowerCase()}|${aspect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ token: match[0].trim(), description, aspect });
    void token;
  }
  return found;
}

export function replaceNeedImageTokens(
  content: string,
  replacements: Array<{ token: string; url: string }>,
) {
  let next = content;
  for (const item of replacements) {
    next = next.split(item.token).join(item.url);
  }
  return next;
}

/**
 * Stand-in for an image nothing could fulfil.
 *
 * A soft neutral panel, inline so the site stays self-contained and deploys
 * without a network fetch. Deliberately plain rather than a loud "missing
 * image" badge: the site should still read as finished, and the person can
 * drop a real picture in from the Assets panel.
 */
export function placeholderImageDataUri(aspect: NeedImageAspect): string {
  const [w, h] =
    aspect === '1:1'
      ? [1200, 1200]
      : aspect === '4:5'
        ? [1200, 1500]
        : aspect === '1200x630'
          ? [1200, 630]
          : [1600, 900];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#e8e3dc"/><stop offset="1" stop-color="#cfc7bd"/>` +
    `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Every token that survived fulfilment, mapped to the placeholder.
 *
 * Without this the literal `NEED_IMAGE: …` string stays in the `src` and the
 * generated site ships with broken images — which is exactly what happened
 * once the fulfilment step stopped being called.
 */
export function placeholderReplacements(text: string): Array<{ token: string; url: string }> {
  return parseNeedImageDirectives(text).map((directive) => ({
    token: directive.token,
    url: placeholderImageDataUri(directive.aspect),
  }));
}
