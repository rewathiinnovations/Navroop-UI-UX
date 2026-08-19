import { describe, expect, it } from 'vitest';
import {
  parseNeedImageDirectives,
  placeholderReplacements,
  replaceNeedImageTokens,
  sweepNeedImageTokens,
} from '@/lib/assets/need-image';

/**
 * A generated site must never ship the literal request token as an image URL.
 *
 * The stack prompt tells the model to ask for pictures as
 * `NEED_IMAGE: description | 16:9` and promises the pipeline swaps them for
 * real URLs before files are written. That step stopped being called when the
 * apply route was deleted, so a real generation stored
 * `<img src="NEED_IMAGE: Warm coffee roastery hero background…">` and the hero
 * image was broken in the preview and would have been broken in production.
 */

// Verbatim from the first live generation (Harbor & Pine, REACT).
const HERO = `      <div className="absolute inset-0">
        <img
          src="NEED_IMAGE: Warm coffee roastery hero background with coffee beans and roaster | 16:9"
          alt="Coffee beans roasting in a warm Portland roastery"
          className="w-full h-full object-cover"
        />
      </div>`;

describe('NEED_IMAGE tokens never reach the stored site', () => {
  it('finds the directive in real generated output', () => {
    const directives = parseNeedImageDirectives(HERO);
    expect(directives).toHaveLength(1);
    expect(directives[0].description).toContain('coffee roastery hero background');
    expect(directives[0].aspect).toBe('16:9');
  });

  it('replaces an unfulfilled token with a self-contained placeholder', () => {
    const resolved = replaceNeedImageTokens(HERO, placeholderReplacements(HERO));
    expect(resolved).not.toContain('NEED_IMAGE');
    expect(resolved).toContain('src="data:image/svg+xml');
    // Inline, so a deployed site needs no network fetch to render it.
    expect(resolved).not.toContain('http://');
    // The alt text the model wrote survives.
    expect(resolved).toContain('Coffee beans roasting in a warm Portland roastery');
  });

  it('leaves a fulfilled token alone', () => {
    const real = replaceNeedImageTokens(HERO, [
      {
        token:
          'NEED_IMAGE: Warm coffee roastery hero background with coffee beans and roaster | 16:9',
        url: 'https://assets.example.com/hero.jpg',
      },
    ]);
    expect(real).toContain('https://assets.example.com/hero.jpg');
    expect(placeholderReplacements(real)).toEqual([]);
  });
});

/**
 * Verbatim from a later live generation (Cinder & Sage, NEXTJS), which shipped two
 * raw tokens into the user's `lib/site.ts`. The aspects are `3:4` and `4:3` — not
 * on the advertised list — and because the description cannot contain `|`, the
 * pattern failed to match them at all: fulfilment never saw them, the placeholder
 * pass never saw them, and the literal string reached stored code.
 */
const SHIPPED_RAW = `  {
    src: "NEED_IMAGE: Blazing wood-fired brick oven with a pizza inside and a chef working the peel | 3:4",
    alt: "The wood-fired oven blazing with a pizza inside",
  },
  {
    src: "NEED_IMAGE: Cozy pizzeria bar with warm pendant lights, shelves of natural wine and a counter | 4:3",
    alt: "The bar counter with natural wine bottles under warm pendant lights",
  },`;

describe('an aspect nobody advertised is still a request', () => {
  it('parses directives whose ratio is not on the list', () => {
    const directives = parseNeedImageDirectives(SHIPPED_RAW);

    expect(directives).toHaveLength(2);
    expect(directives[0].description).toContain('wood-fired brick oven');
    // The description must not swallow the ratio, or the search query is polluted.
    expect(directives[0].description).not.toContain('3:4');
    expect(directives[1].description).toContain('Cozy pizzeria bar');
  });

  it('serves the nearest shape it can produce, matching the requested orientation', () => {
    const [portrait, landscape] = parseNeedImageDirectives(SHIPPED_RAW);

    expect(portrait.aspect).toBe('4:5');
    expect(landscape.aspect).toBe('16:9');
  });

  it('replaces them, so nothing raw is stored', () => {
    const resolved = replaceNeedImageTokens(SHIPPED_RAW, placeholderReplacements(SHIPPED_RAW));

    expect(resolved).not.toContain('NEED_IMAGE');
    expect(resolved).toContain('data:image/svg+xml');
    expect(resolved).toContain('The bar counter with natural wine bottles');
  });

  it('sweeps a shape even the parser misses', () => {
    // No closing quote, a stray pipe, a newline mid-token: whatever the model does,
    // a `NEED_IMAGE:` string must not survive into generated source.
    const malformed = 'const src = "NEED_IMAGE: a pizza | | weird";\nconst other = 1;';
    const swept = sweepNeedImageTokens(malformed);

    expect(swept).not.toContain('NEED_IMAGE');
    expect(swept).toContain('data:image/svg+xml');
    // Everything around it is untouched.
    expect(swept).toContain('const other = 1;');
  });

  it('leaves text with no token exactly as it is', () => {
    const clean = 'const src = "/assets/hero.jpg";';
    expect(sweepNeedImageTokens(clean)).toBe(clean);
  });
});
