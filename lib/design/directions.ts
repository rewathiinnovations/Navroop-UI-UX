export const DESIGN_DIRECTION_IDS = [
  'minimal',
  'bold',
  'premium',
  'playful',
  'editorial',
  'technical',
] as const;

export type DesignDirectionId = (typeof DESIGN_DIRECTION_IDS)[number];

export const DEFAULT_DESIGN_DIRECTION: DesignDirectionId = 'minimal';

export type DesignDirection = {
  id: DesignDirectionId;
  label: string;
  fontPairing: string;
  radiusScale: string;
  spacingScale: string;
  shadowStyle: string;
  colorGuidance: string;
  toneWords: string[];
};

export const DESIGN_DIRECTIONS: Record<DesignDirectionId, DesignDirection> = {
  minimal: {
    id: 'minimal',
    label: 'Minimal',
    fontPairing: 'Inter 600 display + Inter 400 body. 16px base, 1.25 type ratio (16 / 20 / 25 / 31 / 39).',
    radiusScale: '4px controls, 6px cards, 999px pills.',
    spacingScale: '8 / 16 / 24 / 40 / 64. Section padding 64px desktop, 32px at 375px.',
    shadowStyle: 'None. 1px borders only (border-gray-200).',
    colorGuidance:
      'Off-white #FAFAF9 background, ink #111111 text, one accent #2563EB. No gradients. Body contrast ≥ 4.5:1.',
    toneWords: ['spare', 'precise', 'quiet'],
  },
  bold: {
    id: 'bold',
    label: 'Bold',
    fontPairing: 'Space Grotesk 700 display + Inter 400 body. 18px base, 1.333 type ratio (18 / 24 / 32 / 43 / 57).',
    radiusScale: '0px cards, 2px controls, no pills.',
    spacingScale: '8 / 16 / 32 / 48 / 80. Tight clusters, large section breaks.',
    shadowStyle: 'Hard offset 4px 4px 0 #111111. No blur.',
    colorGuidance:
      'White #FFFFFF or black #0A0A0A fields, saturated accent #EF4444 or #2563EB, 3px black borders. No pastels.',
    toneWords: ['loud', 'graphic', 'direct'],
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    fontPairing: 'Fraunces 600 display + Inter 400/500 body. 16px base, 1.25 type ratio (16 / 20 / 25 / 31 / 39).',
    radiusScale: '16px cards, 12px controls, 999px pills.',
    spacingScale: '8 / 16 / 24 / 40 / 64. Generous section padding 80px desktop, 40px at 375px.',
    shadowStyle:
      'Layered depth: 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08). Translucent surfaces bg-white/80 backdrop-blur-md.',
    colorGuidance:
      'Dramatic contrast — near-black #0B0B0F on warm cream #F6F1E8; gold accent #C4A35A. Hero may invert (cream type on #0B0B0F). Surfaces white/10–16% over dark.',
    toneWords: ['cinematic', 'layered', 'refined'],
  },
  playful: {
    id: 'playful',
    label: 'Playful',
    fontPairing: 'Nunito 700 display + Nunito Sans 400 body. 16px base, 1.2 type ratio (16 / 19 / 23 / 28 / 33).',
    radiusScale: '20px cards, 14px controls, 999px pills and buttons.',
    spacingScale: '8 / 16 / 24 / 32 / 48. Airy cards, 24px gaps.',
    shadowStyle: 'Soft colored 0 8px 20px rgba(99,102,241,0.18). Hover lift -2px.',
    colorGuidance:
      'Sky #F0F9FF background, ink #1E1B4B, accents #6366F1 and #F59E0B. Avoid grey-only palettes.',
    toneWords: ['friendly', 'bouncy', 'warm'],
  },
  editorial: {
    id: 'editorial',
    label: 'Editorial',
    fontPairing: 'Playfair Display 600 display + Source Serif 4 400 body. 18px body, 1.333 type ratio, max 65ch measure.',
    radiusScale: '2px images, 0px text blocks, 4px buttons.',
    spacingScale: '8 / 16 / 28 / 48 / 72. Print-like column gutters 24px.',
    shadowStyle: 'None. 1px hairline rules (border-stone-300). Optional 1px inset image keyline.',
    colorGuidance:
      'Paper #F4EFE6, ink #1C1917, spot color #9F1239. No neon, no heavy gradients.',
    toneWords: ['literary', 'measured', 'print'],
  },
  technical: {
    id: 'technical',
    label: 'Technical',
    fontPairing: 'IBM Plex Sans 600 display + IBM Plex Sans 400 body + IBM Plex Mono 400 for code/data. 14px base, 1.2 type ratio.',
    radiusScale: '4px cards and controls, 2px chips.',
    spacingScale: '4 / 8 / 12 / 20 / 32. Dense dashboard rhythm.',
    shadowStyle: 'None. 1px slate borders (border-slate-300). Tabular figures for numbers.',
    colorGuidance:
      'Slate #F8FAFC background, #0F172A text, signal cyan #0891B2. Status via text + icon, not color alone.',
    toneWords: ['exact', 'tabular', 'utilitarian'],
  },
};

export function isDesignDirectionId(value: unknown): value is DesignDirectionId {
  return typeof value === 'string' && (DESIGN_DIRECTION_IDS as readonly string[]).includes(value);
}

export function resolveDirectionId(value: unknown): DesignDirectionId {
  return isDesignDirectionId(value) ? value : DEFAULT_DESIGN_DIRECTION;
}

export function getDirection(id?: string | null): DesignDirection {
  return DESIGN_DIRECTIONS[resolveDirectionId(id)];
}

/** Concrete, implementable instructions — not mood adjectives. */
export function toPromptBlock(direction: DesignDirection): string {
  return `DESIGN DIRECTION — ${direction.id}
Typography: ${direction.fontPairing}
Radius: ${direction.radiusScale}
Spacing: ${direction.spacingScale}
Shadow/depth: ${direction.shadowStyle}
Color: ${direction.colorGuidance}
Tone (keep copy and motion in this register): ${direction.toneWords.join(', ')}.
Load the named Google Fonts in the root layout/head. Use these exact sizes, radii, and colors (as CSS variables once). Do not swap the type pairing or invent a different palette.`;
}
