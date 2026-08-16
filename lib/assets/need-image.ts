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
