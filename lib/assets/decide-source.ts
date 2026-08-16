export type ImageSourceKind = 'stock' | 'generated';

const STOCK_RE =
  /\b(photo|photograph|photographer|people|person|portrait|chef|kitchen|food|meal|dish|restaurant|place|places|city|street|landscape|travel|product|products|packaging|documentary|real[- ]?world|candid)\b/i;

const GENERATED_RE =
  /\b(illustration|illustrative|abstract|gradient|pattern|patterns|icon|icons|hero graphic|og(?:\s+image)?|1200\s*[x×]\s*630|vector|logo|wordmark)\b/i;

/**
 * Photographs of people, food, places, products, or documentary scenes → stock.
 * Illustrations, abstract backgrounds, patterns, icons, hero graphics, OG → generated.
 * UI can override this per request.
 */
export function decideSource(need: string): ImageSourceKind {
  const text = need.trim();
  if (!text) return 'generated';
  if (GENERATED_RE.test(text) && !/\b(photo|photograph)\b/i.test(text)) {
    return 'generated';
  }
  if (STOCK_RE.test(text)) return 'stock';
  if (GENERATED_RE.test(text)) return 'generated';
  return 'generated';
}
