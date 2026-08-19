export const NEED_IMAGE_ASPECTS = ['16:9', '1:1', '4:5', '1200x630'] as const;
export type NeedImageAspect = (typeof NEED_IMAGE_ASPECTS)[number];

export type NeedImageDirective = {
  token: string;
  description: string;
  aspect: NeedImageAspect;
};

/**
 * The aspect suffix accepts anything, deliberately.
 *
 * It used to accept only the four aspects the prompt lists, and because the
 * description cannot contain `|`, an unlisted one made the whole pattern fail to
 * match: a real build asked for `| 3:4` and `| 4:3`, so nothing recognised those
 * directives, fulfilment never saw them, the placeholder sweep never saw them,
 * and the literal `NEED_IMAGE: … | 3:4` string shipped inside the user's
 * `lib/site.ts`. A ratio we did not advertise is a request to interpret, never a
 * reason to leak a token into generated code.
 */
const DIRECTIVE_RE = /NEED_IMAGE:\s*([^|\n<"']+?)(?:\s*\|\s*([^"'<\n]+?))?\s*(?=["'<\n]|$)/gi;

/** Ratios of the aspects the pipeline can actually produce. */
const ASPECT_RATIOS: Array<{ aspect: NeedImageAspect; ratio: number }> = [
  { aspect: '16:9', ratio: 16 / 9 },
  { aspect: '1:1', ratio: 1 },
  { aspect: '4:5', ratio: 4 / 5 },
  { aspect: '1200x630', ratio: 1200 / 630 },
];

function normalizeAspect(value?: string | null): NeedImageAspect {
  const raw = (value ?? '').trim();
  if (!raw) return '16:9';
  const exact = NEED_IMAGE_ASPECTS.find((aspect) => aspect === raw);
  if (exact) return exact;

  // `3:4`, `4:3`, `1920x1080` — a ratio we did not list. Serve the closest one we
  // can produce rather than silently reframing everything as 16:9.
  const parts = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i.exec(raw);
  if (!parts) return '16:9';
  const width = Number(parts[1]);
  const height = Number(parts[2]);
  if (!width || !height) return '16:9';

  const ratio = width / height;
  let best = ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ASPECT_RATIOS) {
    // Compared in log space so 2:1 and 1:2 are equally far from square.
    const distance = Math.abs(Math.log(ratio) - Math.log(candidate.ratio));
    // A tie goes to the shape on the same side of square as the request, so a
    // landscape ask never lands on a portrait crop.
    const closer =
      distance < bestDistance - 1e-9 ||
      (Math.abs(distance - bestDistance) <= 1e-9 &&
        (ratio >= 1 ? candidate.ratio > best.ratio : candidate.ratio < best.ratio));
    if (closer) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best.aspect;
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
    const key = `${description.toLowerCase()}|${aspect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ token: match[0].trim(), description, aspect });
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

/**
 * The floor: no `NEED_IMAGE:` string may reach stored files, whatever the parser
 * made of it.
 *
 * `placeholderReplacements` can only replace what `parseNeedImageDirectives`
 * recognised, so a directive shaped in a way the pattern misses survived every
 * layer and shipped inside the user's source. This works on the raw text instead:
 * from the token to the end of that string literal or line, whatever it contains.
 * Belt and braces on purpose — one is a parser, the other is a guarantee.
 */
export function sweepNeedImageTokens(content: string): string {
  if (!content.includes('NEED_IMAGE:')) return content;
  return content.replace(/NEED_IMAGE:[^"'`<\n]*/gi, (token) => {
    const aspect = /\|\s*([^"'`<\n]+)$/.exec(token)?.[1];
    return placeholderImageDataUri(normalizePublicAspect(aspect));
  });
}

/** `normalizeAspect` for callers outside the parser; same nearest-shape rule. */
function normalizePublicAspect(value?: string | null): NeedImageAspect {
  return parseNeedImageDirectives(`NEED_IMAGE: x | ${(value ?? '').trim()}`)[0]?.aspect ?? '16:9';
}
