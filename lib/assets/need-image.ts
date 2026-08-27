export const NEED_IMAGE_ASPECTS = ['16:9', '1:1', '4:5', '1200x630'] as const;
export type NeedImageAspect = (typeof NEED_IMAGE_ASPECTS)[number];

export type NeedImageDirective = {
  /**
   * Every occurrence of this request, byte-for-byte as it appears in the source.
   *
   * A list rather than one reconstructed string because two requests that differ
   * only by a placement note — `… | 1:1` and `… | 1:1 | About section` — are one
   * picture and therefore one directive, but they are two distinct pieces of text
   * that both have to be rewritten. Replacing a directive by anything other than
   * the text that was actually matched leaves a tail behind; see
   * {@link replaceNeedImageTokens}.
   */
  tokens: string[];
  description: string;
  aspect: NeedImageAspect;
};

/**
 * Where a directive was found, which is the only thing that decides where it ends.
 *
 * In a file the token sits inside an attribute — `src="NEED_IMAGE: … "` — so the
 * quote that opened it is what has to close it, and a bare token written into JSX
 * text has to stop before the next `<` or the match eats the closing tag. None of
 * that is true of prose, where an apostrophe is just an apostrophe: sharing one
 * terminator set with the file side meant `NEED_IMAGE: a barista's hands pouring
 * chai | 1:1` stripped only as far as the `'`, and the surviving `'s hands pouring
 * chai | 1:1` rendered verbatim as the assistant's chat message — the exact leak
 * the chat strip exists to close.
 *
 * One scanner, two terminator sets. The shape of a token is still defined once, so
 * the file floor and the chat floor cannot drift apart the way they did when they
 * were two regexes written a month apart.
 *
 * Module-internal: callers pass the literal `'file'` / `'prose'` straight into
 * `parseNeedImageDirectives`, so nothing outside needs the name, and an export no
 * module imports is a symbol a test can silently stop covering.
 */
type NeedImageContext = 'file' | 'prose';

const MARKER = 'NEED_IMAGE:';
const MARKER_RE = /NEED_IMAGE:/gi;
const QUOTES = new Set(['"', "'", '`']);

/**
 * Cheap bail-out for the overwhelming majority of text, which has no token at all.
 *
 * Exported because the corrective ask (`imagesOwedByReply`, lib/generation/no-changes.ts)
 * runs on every model reply and would otherwise pay for a full block scan of a
 * hundred-kilobyte build to learn there was never a marker in it. One definition of
 * "could this text contain a directive", so the guard and the scanner cannot disagree
 * about case.
 */
export function hasNeedImageMarker(text: string): boolean {
  return /NEED_IMAGE:/i.test(text);
}

type RawToken = { text: string; start: number; end: number };

/**
 * Every raw `NEED_IMAGE:` run in `text`, with its exact extent.
 *
 * Deliberately a hand-rolled scan rather than one clever pattern: the terminator
 * depends on the character that opened the token, which a single regex can only
 * express with a back-reference inside a lookbehind, and the previous shape —
 * nested `*` quantifiers over overlapping classes — is how a long line turns into
 * quadratic CPU time. This walks each token once.
 */
function scanRawTokens(text: string, context: NeedImageContext): RawToken[] {
  const marker = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) starts.push(match.index);

  return starts.map((start, index) => {
    // A second directive ends the first one. Without this the prose rule, which
    // otherwise runs to end of line, swallows `NEED_IMAGE: a | 1:1 NEED_IMAGE: b
    // | 1:1` whole and buys one picture for two requests.
    const limit = starts[index + 1] ?? text.length;
    const opener = start > 0 ? text[start - 1] : '';
    const quoted = QUOTES.has(opener);
    const bodyStart = start + MARKER.length;

    let end = bodyStart;
    while (end < limit) {
      const char = text[end];
      if (char === '\n') break;
      if (quoted) {
        // Only the delimiter that opened the attribute closes it, so a quote of
        // the other kind inside the description is description.
        if (char === opener || char === '<') break;
      } else if (context === 'file' && (char === '<' || QUOTES.has(char))) {
        break;
      }
      end += 1;
    }
    // Trailing whitespace (and the `\r` of a CRLF file) is not part of the request;
    // leaving it in the token puts it back inside the `src` on replacement.
    while (end > bodyStart && (text[end - 1] === ' ' || text[end - 1] === '\t' || text[end - 1] === '\r')) {
      end -= 1;
    }
    return { text: text.slice(start, end), start, end };
  });
}

/**
 * How long a description may be before it stops being one.
 *
 * An unterminated attribute, a minified line or a model that never wrote a `|`
 * makes the "description" the whole rest of the line, and that string is what is
 * handed to the image worker as a prompt and to the stock providers as a search
 * query. Bounded at a word boundary so the request still reads as English.
 */
const MAX_DESCRIPTION_CHARS = 300;

/** A ratio is a handful of characters; anything longer is annotation, not an aspect. */
const MAX_ASPECT_CHARS = 24;

/** Ratios of the aspects the pipeline can actually produce. */
const ASPECT_RATIOS: Array<{ aspect: NeedImageAspect; ratio: number }> = [
  { aspect: '16:9', ratio: 16 / 9 },
  { aspect: '1:1', ratio: 1 },
  { aspect: '4:5', ratio: 4 / 5 },
  { aspect: '1200x630', ratio: 1200 / 630 },
];

/**
 * The aspect field accepts anything, deliberately.
 *
 * It used to accept only the four aspects the prompt lists, and because the
 * description cannot contain `|`, an unlisted one made the whole pattern fail to
 * match: a real build asked for `| 3:4` and `| 4:3`, so nothing recognised those
 * directives, fulfilment never saw them, the placeholder sweep never saw them,
 * and the literal `NEED_IMAGE: … | 3:4` string shipped inside the user's
 * `lib/site.ts`. A ratio we did not advertise is a request to interpret, never a
 * reason to leak a token into generated code.
 */
function normalizeAspect(value?: string | null): NeedImageAspect {
  const raw = (value ?? '').trim();
  // The length guard is not cosmetic: without it the numeric pattern below runs
  // over whatever a pathological line put after the pipe.
  if (!raw || raw.length > MAX_ASPECT_CHARS) return '16:9';
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

function boundDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  const cut = value.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_DESCRIPTION_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * What one raw token asks for.
 *
 * Only the first `|`-separated field is the aspect. The rest of the tail is a note
 * to nobody — `… | 1:1 | About section`, which is exactly how the live Chai Point
 * build wrote all four of its prose requests — and handing that whole tail to the
 * matcher parsed nothing, so a square portrait was silently reframed as a 16:9
 * default. The note stays in the token text, because the token text is what gets
 * rewritten.
 */
function readDirectiveBody(token: string): { description: string; aspect: NeedImageAspect } {
  const fields = token.slice(MARKER.length).split('|');
  return {
    description: boundDescription(fields[0].replace(/\s+/g, ' ').trim()),
    aspect: normalizeAspect(fields[1]),
  };
}

/**
 * Identity of a request, for de-duplication.
 *
 * Exported because the reply pass in `lib/assets/fulfill.ts` has to subtract the
 * directives the file pass already fulfilled, and a second definition of "the
 * same picture" there would drift from the one the parser dedupes on — which
 * would spend an image credit twice for one request.
 */
export function needImageKey(directive: Pick<NeedImageDirective, 'description' | 'aspect'>): string {
  return `${directive.description.toLowerCase()}|${directive.aspect}`;
}

/**
 * A parsed directive written back in the canonical shape the file scanner reads.
 *
 * Used by the corrective ask, which hands the model the requests it wrote as prose and
 * tells it to put them in a `src`. Reconstructed rather than echoed from
 * {@link NeedImageDirective.tokens}: the raw text is whatever the model typed, so it can
 * carry a placement note (`… | 1:1 | About section`), an aspect nothing can produce
 * (`| 3:4`), or a line long enough to be its own paragraph — and the ask would then be
 * teaching the model to write back the exact string that already failed. This is bounded
 * by the parser (description capped, aspect normalised to one of the four), so what the
 * model is asked to place is what fulfilment can serve.
 */
export function formatNeedImageToken(
  directive: Pick<NeedImageDirective, 'description' | 'aspect'>,
): string {
  return `${MARKER} ${directive.description} | ${directive.aspect}`;
}

export function parseNeedImageDirectives(
  text: string,
  context: NeedImageContext = 'file',
): NeedImageDirective[] {
  const byKey = new Map<string, NeedImageDirective>();
  for (const raw of scanRawTokens(text, context)) {
    const body = readDirectiveBody(raw.text);
    // `NEED_IMAGE:|16:9` and friends ask for nothing nameable. There is no image
    // to buy, but the string still must not ship — that is `sweepNeedImageTokens`,
    // which works on the raw text and does not care what parsed.
    if (!body.description) continue;
    const key = needImageKey(body);
    const existing = byKey.get(key);
    if (existing) {
      // One picture, every place that asked for it. Collapsing the second request
      // away entirely is what left its annotation tail sitting inside the `src`.
      if (!existing.tokens.includes(raw.text)) existing.tokens.push(raw.text);
      continue;
    }
    byKey.set(key, { tokens: [raw.text], ...body });
  }
  return [...byKey.values()];
}

export function replaceNeedImageTokens(
  content: string,
  replacements: Array<{ token: string; url: string }>,
) {
  // Longest token first. `NEED_IMAGE: cafe interior | 1:1` is a prefix of
  // `NEED_IMAGE: cafe interior | 1:1 | About section`; they are the same picture,
  // so both are rewritten to the same URL, and replacing the short one first turned
  // the second into `src="https://cdn/x.png | About section"` — a URL with a space
  // in it that resolves to nothing, in a `src` the sweep can no longer recognise
  // because the marker is gone. That section rendered a broken image with no
  // placeholder and no entry in `unfulfilled`.
  let next = content;
  for (const item of [...replacements].sort((a, b) => b.token.length - a.token.length)) {
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
 * once the fulfilment step stopped being called. One entry per occurrence, not
 * per directive: two placements of one request are two strings to rewrite.
 */
export function placeholderReplacements(text: string): Array<{ token: string; url: string }> {
  return parseNeedImageDirectives(text).flatMap((directive) =>
    directive.tokens.map((token) => ({
      token,
      url: placeholderImageDataUri(directive.aspect),
    })),
  );
}

/** Rewrites every raw token in place, leaving everything around it byte-identical. */
function rewriteRawTokens(
  text: string,
  context: NeedImageContext,
  replace: (token: string) => string,
): string {
  if (!hasNeedImageMarker(text)) return text;
  const tokens = scanRawTokens(text, context);
  if (tokens.length === 0) return text;
  let out = '';
  let at = 0;
  for (const raw of tokens) {
    out += text.slice(at, raw.start) + replace(raw.text);
    at = raw.end;
  }
  return out + text.slice(at);
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
  return rewriteRawTokens(content, 'file', (token) =>
    placeholderImageDataUri(readDirectiveBody(token).aspect),
  );
}

/**
 * A line that carried nothing but a list marker once its directive was removed.
 *
 * Written as one class, then an optional numbered marker carrying its own
 * trailing run, rather than two runs of the same class either side of it: the
 * latter has to try every split point before it can fail, so a line of fifty
 * thousand spaces followed by one word cost quadratic time in a code path that
 * runs on every line of every assistant reply.
 */
const BARE_LIST_LEAD_RE = /^[\s\-*•>#]*(?:\d+[.)][\s\-*•>#]*)?$/;

/**
 * The chat-facing twin of {@link sweepNeedImageTokens}: the same textual floor,
 * applied to the assistant's own words instead of to a stored file.
 *
 * A live build (deepseek-v4-flash, NEXTJS) wrote its four picture requests as
 * prose lines rather than into a `src`, and the conversational stream is
 * rendered verbatim as the assistant's chat message — so the customer's first
 * build ended with four lines of internal protocol in the transcript. A file
 * gets a placeholder because a `src` has to hold something; chat gets nothing,
 * because a line that was only a directive was never speech. Lines that still
 * carry words keep them, so "Here is the hero: NEED_IMAGE: …" does not vanish.
 */
export function stripNeedImageTokens(text: string): string {
  if (!hasNeedImageMarker(text)) return text;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const stripped = rewriteRawTokens(line, 'prose', () => '');
    if (stripped === line) {
      kept.push(line);
      continue;
    }
    if (BARE_LIST_LEAD_RE.test(stripped)) continue;
    kept.push(stripped);
  }
  return kept.join('\n');
}
