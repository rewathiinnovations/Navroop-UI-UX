import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const AA = 4.5;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function lightStudioTokens(css: string): Record<string, string> {
  const block = css.match(/\.studio-shell\s*\{([^}]+)\}/);
  if (!block) throw new Error('missing .studio-shell tokens');
  const tokens: Record<string, string> = {};
  for (const match of block[1].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}

describe('studio light accent contrast (auth / home)', () => {
  const css = readFileSync(resolve(process.cwd(), 'components/app/studio/studio.css'), 'utf8');
  const tokens = lightStudioTokens(css);

  it('white CTA text on accent is at least 4.5:1', () => {
    const ratio = contrastRatio(tokens['studio-cta-fg'], tokens['studio-accent']);
    expect(ratio, `${tokens['studio-cta-fg']} on ${tokens['studio-accent']} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });

  it('accent text on studio background is at least 4.5:1', () => {
    const ratio = contrastRatio(tokens['studio-accent'], tokens['studio-bg']);
    expect(ratio, `${tokens['studio-accent']} on ${tokens['studio-bg']} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });
});
