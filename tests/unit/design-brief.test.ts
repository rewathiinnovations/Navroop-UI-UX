import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { buildUiUxProMaxBrief, selectUiUxProfiles } from '@/lib/ui-ux-pro-max/build-design-brief';

/**
 * `buildUiUxProMaxBrief` shapes every generated site and had no test at all.
 * Three defects were found by replaying its pure functions by hand:
 *
 * - F-829: `pickBest` seeded `bestScore = -1` and advanced on strict `>`, so the
 *   first array element won every tie — and ties were the norm. `STYLES[0]` is
 *   Glassmorphism, so 6 of 7 realistic prompts got frosted glass while the
 *   documented default direction is `minimal`.
 * - F-830: `text.includes(keyword)` matched substrings, so "hair" hit `'ai'` and
 *   "homepage" hit `'home'`.
 * - F-831: style and palette were picked independently, so a light style could be
 *   paired with a dark palette and a hardcoded "Cards: white" line fought both.
 */

const styleOf = (brief: string) => /### Style: (.+)/.exec(brief)?.[1];
const paletteOf = (brief: string) => /### Color system: (.+)/.exec(brief)?.[1];
const typographyOf = (brief: string) => /### Typography: (.+)/.exec(brief)?.[1];

// The seven prompts replayed in the audit. Six landed on Glassmorphism.
const ORDINARY_PROMPTS = [
  'a website for my restaurant',
  'a bakery site with a menu',
  'a portfolio for a photographer',
  'a landing page for a law firm',
  'a homepage for a plumbing company',
  'a site for a hair salon',
  'an online shop for handmade soap',
];

describe('F-829 the chosen design direction decides the style, not array position', () => {
  it('a prompt with no style keyword does not collapse to Glassmorphism', () => {
    const styles = ORDINARY_PROMPTS.map((prompt) => styleOf(buildUiUxProMaxBrief({ prompt })));
    expect(styles).not.toContain('Glassmorphism');
    // The default direction is `minimal`, so the default style is its counterpart.
    expect(new Set(styles)).toEqual(new Set(['Minimalist']));
  });

  it('every direction maps to a declared style, and an unknown id falls back', () => {
    const expected: Record<string, string> = {
      minimal: 'Minimalist',
      bold: 'Brutalism',
      premium: 'Glassmorphism',
      playful: 'Neumorphism',
      editorial: 'Minimalist',
      technical: 'Flat Design',
      // Nothing may fall through to STYLES[0] because an id is unrecognised.
      nonsense: 'Minimalist',
    };
    // Every id in the union must be covered, so a new direction cannot silently
    // inherit Glassmorphism.
    for (const id of DESIGN_DIRECTION_IDS) expect(Object.keys(expected)).toContain(id);
    for (const [designDirection, style] of Object.entries(expected)) {
      const brief = buildUiUxProMaxBrief({
        prompt: 'a website for my restaurant',
        designDirection,
      });
      expect(styleOf(brief), designDirection).toBe(style);
    }
  });

  it('an explicit style hint still wins over the direction', () => {
    const brief = buildUiUxProMaxBrief({
      prompt: 'a website for my restaurant',
      styleHint: 'glass',
      designDirection: 'minimal',
    });
    expect(styleOf(brief)).toBe('Glassmorphism');
  });

  it('a real style keyword in the prompt still refines the direction', () => {
    const brief = buildUiUxProMaxBrief({
      prompt: 'a synthwave neon arcade landing page',
      designDirection: 'minimal',
    });
    expect(styleOf(brief)).toBe('Retro Wave');
  });

  it('the direction breaks a tie between two equally-scoring styles', () => {
    // 'saas' is a keyword of Glassmorphism, Flat Design and the SaaS palette.
    expect(
      styleOf(buildUiUxProMaxBrief({ prompt: 'a saas tool', designDirection: 'technical' })),
    ).toBe('Flat Design');
    expect(
      styleOf(buildUiUxProMaxBrief({ prompt: 'a saas tool', designDirection: 'premium' })),
    ).toBe('Glassmorphism');
  });
});

describe('F-830 keywords match whole words, not accidental letter sequences', () => {
  it("'redesign' does not select the Creative palette through 'design'", () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'redesign my restaurant website' });
    expect(paletteOf(brief)).toBe('Restaurant');
  });

  it("'hair' does not select the Tech Startup typeface through 'ai'", () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a site for a hair salon' });
    expect(typographyOf(brief)).not.toBe('Tech Startup');
  });

  it("'homepage' does not select the Real Estate palette through 'home'", () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a homepage for a plumbing company' });
    expect(paletteOf(brief)).not.toBe('Real Estate');
  });

  it('a standalone short keyword still matches', () => {
    expect(typographyOf(buildUiUxProMaxBrief({ prompt: 'an ai research tool' }))).toBe(
      'Tech Startup',
    );
    expect(paletteOf(buildUiUxProMaxBrief({ prompt: 'a real estate agency' }))).toBe('Real Estate');
  });

  it('no keyword hit anywhere yields the declared defaults, not STYLES[0] neighbours', () => {
    const picks = selectUiUxProfiles({ prompt: 'zzz qqq' });
    expect(picks.colors.name).toBe('SaaS');
    expect(picks.type.name).toBe('Minimal Swiss');
    expect(picks.landing.name).toBe('Hero + Features + CTA');
  });
});

describe('F-831 style and palette are coherent', () => {
  it('a light style is never paired with a dark palette', () => {
    const picks = selectUiUxProfiles({ prompt: 'a minimal bank website' });
    expect(picks.style.name).toBe('Minimalist');
    expect(picks.style.surface).toBe('light');
    expect(picks.colors.mode).toBe('light');
    // The industry signal survives: Fintech's navy and green stay, only the
    // surface pair is replaced, so the brief no longer names a dark background
    // under "Swiss grid, generous whitespace, almost no shadows".
    expect(picks.colors.name).toBe('Fintech');
    expect(picks.colors.primary).toBe('#0F172A');
    expect(picks.colors.accent).toBe('#22C55E');
    expect(picks.colors.background).toBe('#F8FAFC');
    expect(picks.colors.foreground).toBe('#0F172A');
  });

  it('a dark style is never paired with a light palette', () => {
    const picks = selectUiUxProfiles({ prompt: 'a saas platform', styleHint: 'dark' });
    expect(picks.style.name).toBe('Dark Mode');
    expect(picks.colors.mode).toBe('dark');
    // SaaS hues on a dark surface, instead of #F8FAFC under "no large white
    // surfaces" and an `avoid:` line that forbids pure white cards.
    expect(picks.colors.name).toBe('SaaS');
    expect(picks.colors.background).toBe('#0A0E17');
  });

  it('every direction x prompt combination produces a compatible pair', () => {
    const prompts = [
      ...ORDINARY_PROMPTS,
      'a minimal bank website',
      'a dark cinema streaming site',
      'a crypto trading dashboard',
      'an esports gaming team page',
      'a luxury spa hotel',
      'a school course catalog',
      'a clean docs site for developers',
    ];
    const incoherent: string[] = [];
    for (const designDirection of [...DESIGN_DIRECTION_IDS, undefined]) {
      for (const prompt of prompts) {
        for (const styleHint of [undefined, 'dark', 'glass', 'brutal']) {
          const { style, colors } = selectUiUxProfiles({ prompt, designDirection, styleHint });
          if (style.surface !== 'either' && style.surface !== colors.mode) {
            incoherent.push(
              `${designDirection ?? 'default'} / ${styleHint ?? 'no hint'} / ${prompt}: ${style.name} + ${colors.name}`,
            );
          }
        }
      }
    }
    expect(incoherent).toEqual([]);
  });

  it('the card guidance follows the palette instead of hardcoding white', () => {
    const dark = buildUiUxProMaxBrief({ prompt: 'a crypto trading terminal', styleHint: 'dark' });
    expect(dark).not.toMatch(/Cards: white/);
    expect(dark).toMatch(/Cards: /);

    const light = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(light).toMatch(/Cards: white/);
  });

  it('the emitted background hex is the selected palette background', () => {
    const picks = selectUiUxProfiles({ prompt: 'a crypto trading terminal', styleHint: 'dark' });
    const brief = buildUiUxProMaxBrief({ prompt: 'a crypto trading terminal', styleHint: 'dark' });
    expect(brief).toContain(`- Background: ${picks.colors.background}`);
  });
});

describe('F-832 the quality bar does not contradict the colour system', () => {
  // The brief told the model "Standard Tailwind classes only" and then, in the
  // colour section above it, "use these hex values in Tailwind arbitrary colors".
  // An arbitrary-value class is not a standard class, so the model was free to
  // discard the selected palette entirely and no test would notice.
  it('permits the arbitrary-value colour classes the palette section requires', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(brief).toMatch(/Tailwind arbitrary colors/);
    expect(brief).not.toMatch(/Standard Tailwind classes only/);
    expect(brief).toMatch(/arbitrary-value classes carrying the hex values/);
  });

  it('still bans the shadcn semantic tokens generated projects cannot back', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(brief).toMatch(/No shadcn semantic token classes/);
    for (const token of ['bg-background', 'text-foreground', 'bg-primary', 'border-border']) {
      expect(brief).toContain(token);
    }
  });
});

describe('the edit branch is unchanged', () => {
  it('an edit brief preserves the existing system and names no palette', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'make the header sticky', isEdit: true });
    expect(brief).toContain('PRESERVE DESIGN');
    expect(brief).not.toContain('### Color system');
  });
});
