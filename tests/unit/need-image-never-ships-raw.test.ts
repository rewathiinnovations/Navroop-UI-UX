import { describe, expect, it } from 'vitest';
import {
  parseNeedImageDirectives,
  placeholderReplacements,
  replaceNeedImageTokens,
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
