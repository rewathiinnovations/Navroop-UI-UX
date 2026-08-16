import type { DesignTokens } from './types.ts';

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((part) => clampByte(part).toString(16).padStart(2, '0')).join('')}`;
}

function parseRgb(value: string): [number, number, number] | null {
  const rgb = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const raw = hex[1];
  if (raw.length === 3) {
    return [
      parseInt(raw[0] + raw[0], 16),
      parseInt(raw[1] + raw[1], 16),
      parseInt(raw[2] + raw[2], 16),
    ];
  }
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
}

function quantize([r, g, b]: [number, number, number]) {
  const step = 32;
  return toHex(Math.round(r / step) * step, Math.round(g / step) * step, Math.round(b / step) * step);
}

export function clusterColors(values: string[], cap = 8) {
  const counts = new Map<string, { hex: string; count: number }>();
  for (const value of values) {
    const rgb = parseRgb(value.trim());
    if (!rgb) continue;
    const hex = quantize(rgb);
    const current = counts.get(hex);
    if (current) current.count += 1;
    else counts.set(hex, { hex, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, cap)
    .map((entry) => entry.hex);
}

export function uniqueTrimmed(values: string[], cap = 8) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = value.replace(/\s+/g, ' ').trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= cap) break;
  }
  return out;
}

export function formatDesignTokens(tokens: DesignTokens) {
  return [
    'EXTRACTED DESIGN TOKENS',
    `Font stack: ${tokens.fontFamily || 'system-ui, sans-serif'}`,
    `Font sizes: ${tokens.fontSizes.join(', ') || '16px'}`,
    `Colors: ${tokens.colors.join(', ') || '#111111, #ffffff'}`,
    `Radii: ${tokens.radii.join(', ') || '8px'}`,
    `Spacing rhythm: ${tokens.spacingRhythm.join(', ') || '8px / 16px / 24px'}`,
  ].join('\n');
}
