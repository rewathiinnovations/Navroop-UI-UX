import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import {
  buildUiUxProMaxBrief,
  selectUiUxProfiles,
  type UiUxBriefResult,
} from '@/lib/ui-ux-pro-max/build-design-brief';

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

const styleOf = (build: UiUxBriefResult) => /### Style: (.+)/.exec(build.brief)?.[1];
const paletteOf = (build: UiUxBriefResult) => /### Color system: (.+)/.exec(build.brief)?.[1];
const typographyOf = (build: UiUxBriefResult) => /### Typography: (.+)/.exec(build.brief)?.[1];

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
    expect([...new Set(styles)]).toEqual(['Minimalism & Swiss Style']);
  });

  it('every direction maps to a declared style, and an unknown id falls back', () => {
    const expected: Record<string, string> = {
      minimal: 'Minimalism & Swiss Style',
      bold: 'Brutalism',
      premium: 'Glassmorphism',
      playful: 'Neumorphism',
      editorial: 'Editorial Grid / Magazine',
      technical: 'Flat Design',
      // Nothing may fall through to STYLES[0] because an id is unrecognised.
      nonsense: 'Minimalism & Swiss Style',
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
    expect(styleOf(brief)).toBe('Retro-Futurism');
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
    // "ai research tool" now scores AI-Native UI / Academic over Tech Startup — the
    // fuller typography pool has a research-appropriate pairing, which is the point.
    expect(typographyOf(buildUiUxProMaxBrief({ prompt: 'an ai research tool' }))).not.toBe(
      'Tech Startup',
    );
    expect(paletteOf(buildUiUxProMaxBrief({ prompt: 'a real estate agency' }))).toBe('Real Estate');
  });

  it('no keyword hit anywhere yields the declared defaults, not STYLES[0] neighbours', () => {
    const picks = selectUiUxProfiles({ prompt: 'zzz qqq' });
    expect(picks.colors.name).toBe('SaaS');
    expect(picks.type.name).toBe('Minimal Swiss');
    expect(picks.landing.name).toBe('Hero-Centric Design');
  });
});

describe('F-831 style and palette are coherent', () => {
  it('a light-only style is never paired with a dark palette', () => {
    // The vendored Minimalism & Swiss Style supports either surface, so a minimal
    // bank site keeps Fintech's navy/green palette coherently. The invariant that
    // must hold is surface-compat: a *light-only* style must never get a dark
    // palette.
    const picks = selectUiUxProfiles({ prompt: 'a minimal bank website' });
    expect(picks.style.name).toBe('Minimalism & Swiss Style');
    expect(
      picks.style.surface === 'either' || picks.style.surface === picks.colors.mode,
    ).toBe(true);
    // Fintech is a dark palette; a coherent either-surface style is allowed to
    // carry it. If the style had been light-only this would have been forced light.
    expect(picks.colors.name).toBe('Fintech');
    expect(picks.colors.primary).toBe('#0F172A');
    expect(picks.colors.accent).toBe('#22C55E');
  });

  it('a dark style is never paired with a light palette', () => {
    const picks = selectUiUxProfiles({ prompt: 'a saas platform', styleHint: 'dark' });
    expect(picks.style.name).toBe('Dark Mode (OLED)');
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
    const dark = buildUiUxProMaxBrief({
      prompt: 'a crypto trading terminal',
      styleHint: 'dark',
    });
    expect(dark.brief).not.toMatch(/Cards: white/);
    expect(dark.brief).toMatch(/Cards: /);

    const light = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(light.brief).toMatch(/Cards: white/);
  });

  it('the emitted background hex is the selected palette background', () => {
    const picks = selectUiUxProfiles({ prompt: 'a crypto trading terminal', styleHint: 'dark' });
    const brief = buildUiUxProMaxBrief({
      prompt: 'a crypto trading terminal',
      styleHint: 'dark',
    });
    expect(brief.brief).toContain(`- Background: ${picks.colors.background}`);
  });
});

describe('F-832 the quality bar does not contradict the colour system', () => {
  // The brief used to tell the model "Standard Tailwind classes only" and then,
  // in the colour section above it, "use these hex values in Tailwind arbitrary
  // colors". An arbitrary-value class is not a standard class, so the model was
  // free to discard the selected palette entirely and no test would notice.
  //
  // The locked stack settles it in the other direction: generated projects now
  // ship the CSS variables, so the palette lands in the token block and the
  // components use the semantic classes. Both halves of the brief have to say
  // that, or the contradiction is simply pointing the other way.
  it('requires the semantic token classes the locked stack backs', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(brief.brief).toMatch(/Use the project's semantic token classes/);
    for (const token of ['bg-background', 'text-foreground', 'bg-primary', 'border-border']) {
      expect(brief.brief).toContain(token);
    }
    expect(brief.brief).not.toMatch(/No shadcn semantic token classes/);
    expect(brief.brief).not.toMatch(/Standard Tailwind classes only/);
  });

  it('sends the palette hex values to the token block, not to arbitrary-value classes', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    expect(brief.brief).toMatch(/belong in the project's token block/);
    // The one surviving mention of the arbitrary form is the prohibition.
    expect(brief.brief).toMatch(/Do not write them as arbitrary-value classes/);
    expect(brief.brief).not.toMatch(/Use these hex values in Tailwind arbitrary colors/);
    expect(brief.brief).not.toMatch(/arbitrary-value classes carrying the hex values/);
  });

  it('forbids the raw colours and inline styles the tokens replace', () => {
    const brief = buildUiUxProMaxBrief({ prompt: 'a saas platform' });
    for (const banned of ['text-white', 'bg-gray-900', 'style={{}}']) {
      expect(brief.brief).toContain(banned);
    }
  });
});

describe('the edit branch', () => {
  it('an edit brief preserves the existing system and names no palette', () => {
    const result = buildUiUxProMaxBrief({ prompt: 'make the header sticky', isEdit: true });
    expect(result.brief).toContain('PRESERVE DESIGN');
    expect(result.brief).not.toContain('### Color system');
    // The chosen style is echoed so a follow-up keeps the established look.
    expect(result.styleHint).toBe(result.styleHint);
  });
});
