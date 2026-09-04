import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTION_IDS, getDirectionTokens } from '@/lib/design/directions';
import { inferDesignDirection } from '@/lib/design/infer-direction';
import { hexToHsl, readableForeground, resolveProjectTokens } from '@/lib/design/palette-tokens';
import { selectUiUxProfiles } from '@/lib/ui-ux-pro-max/build-design-brief';

/**
 * One design system, chosen from what the user wrote.
 *
 * Before this, the hero carried a Design direction select that defaulted to
 * `minimal` and that almost nobody changed, so a project's stored direction had
 * nothing to do with its prompt — while the UI/UX brief scored the same prompt
 * and picked something else. Both blocks went into the prompt marked mandatory.
 * A generated dental clinic came out gold on cream with a Playfair heading and a
 * `shadow-elegant` utility, under `designDirection: "minimal"`, whose own rules
 * say Inter, one blue accent, and no shadows.
 */

describe('inferDesignDirection', () => {
  it('reads the direction out of the brief', () => {
    expect(inferDesignDirection('a luxury spa and hotel in Goa')).toBe('premium');
    expect(inferDesignDirection('an analytics dashboard for our API')).toBe('technical');
    expect(inferDesignDirection('a magazine about independent publishing')).toBe('editorial');
    expect(inferDesignDirection('a nursery school for children aged 3 to 6')).toBe('playful');
    expect(inferDesignDirection('a streetwear sneaker drop landing page')).toBe('bold');
    expect(inferDesignDirection('a law firm in Amritsar')).toBe('minimal');
  });

  it('lets a mood word decide when the industry is already covered elsewhere', () => {
    // The clinic still selects the Healthcare palette; `premium` is what makes it
    // a *premium* clinic, and the direction is where that belongs.
    expect(inferDesignDirection('a premium dental clinic in Amritsar')).toBe('premium');
    expect(inferDesignDirection('a dental clinic in Amritsar')).toBe('minimal');
  });

  it('falls back to the documented default, never throws', () => {
    expect(inferDesignDirection('')).toBe('minimal');
    expect(inferDesignDirection('zzz qqq')).toBe('minimal');
    expect(DESIGN_DIRECTION_IDS).toContain(inferDesignDirection('!!! ???'));
  });
});

describe('the palette follows the industry, not an adjective', () => {
  it('gives a premium dental clinic the healthcare palette', () => {
    // `premium` (Luxury) and `clinic` (Healthcare) both scored 2, and the tie was
    // broken by array position — Luxury is declared first — so a dental clinic
    // was styled as a fashion house.
    const picks = selectUiUxProfiles({
      prompt: 'a premium dental clinic in Amritsar',
      designDirection: 'premium',
    });
    expect(picks.colors.name).toBe('Healthcare');
  });

  it('still gives a spa hotel the luxury palette', () => {
    const picks = selectUiUxProfiles({ prompt: 'a luxury spa hotel', designDirection: 'premium' });
    expect(picks.colors.name).toBe('Luxury');
  });

  it('excludes a style whose own row says it is wrong for the sector', () => {
    // Glassmorphism's vendored `avoid` line reads "serious/medical". It was
    // shipped to a dental clinic anyway, because nothing read it.
    const picks = selectUiUxProfiles({
      prompt: 'a premium dental clinic in Amritsar',
      designDirection: 'premium',
    });
    expect(picks.style.name).not.toBe('Glassmorphism');
    expect(picks.style.avoid.toLowerCase()).not.toContain('medical');
  });
});

describe('resolveProjectTokens', () => {
  const healthcare = {
    mode: 'light' as const,
    primary: '#0891B2',
    background: '#ECFEFF',
    foreground: '#164E63',
  };

  it('takes colour from the palette and form from the direction', () => {
    const direction = getDirectionTokens('premium');
    const tokens = resolveProjectTokens(direction, healthcare);
    expect(tokens.primary).toBe('192 91% 36%');
    // Radius and shadow are the direction's, unchanged: that split is what stops
    // the two prompt blocks from describing two different sites.
    expect(tokens.radius).toBe(direction.radius);
    expect(tokens.shadow).toBe(direction.shadow);
  });

  it('derives a readable CTA foreground instead of leaving it to taste', () => {
    // The invisible-button class of bug, removed by construction.
    expect(readableForeground(hexToHsl('#0891B2')!)).toBe('0 0% 100%');
    expect(readableForeground(hexToHsl('#FAFAF9')!)).toBe('0 0% 8%');
  });

  it('raises a card off a dark page instead of putting a white rectangle on it', () => {
    const tokens = resolveProjectTokens(getDirectionTokens('technical'), {
      mode: 'dark',
      primary: '#22C55E',
      background: '#020617',
      foreground: '#F8FAFC',
    });
    const lightness = (triplet: string) => Number(triplet.split(' ')[2].replace('%', ''));
    expect(lightness(tokens.surface)).toBeGreaterThan(lightness(tokens.background));
    expect(lightness(tokens.surface)).toBeLessThan(30);
  });

  it('keeps the direction tokens when a hex does not parse', () => {
    const direction = getDirectionTokens('minimal');
    const tokens = resolveProjectTokens(direction, {
      mode: 'light',
      primary: 'not-a-colour',
      background: '#FFFFFF',
      foreground: '#000000',
    });
    // A variable of `NaN` renders as transparent rather than as an error, so the
    // honest outcome is the palette we know is complete.
    expect(tokens).toEqual(direction);
  });
});

describe('the brief carries one token block', () => {
  it('emits the resolved variables as CSS, ready to paste', () => {
    const picks = selectUiUxProfiles({
      prompt: 'a premium dental clinic in Amritsar',
      designDirection: 'premium',
    });
    expect(picks.tokens.primary).toBe('192 91% 36%');
    expect(picks.direction).toBe('premium');
  });
});
