type StyleProfile = {
  name: string;
  aliases: string[];
  keywords: string[];
  prompt: string;
  tokens: string;
  avoid: string;
};

type ColorProfile = {
  name: string;
  keywords: string[];
  primary: string;
  accent: string;
  background: string;
  foreground: string;
  notes: string;
};

type TypeProfile = {
  name: string;
  keywords: string[];
  heading: string;
  body: string;
  importUrl: string;
};

type LandingProfile = {
  name: string;
  keywords: string[];
  sections: string;
  cta: string;
};

const STYLES: StyleProfile[] = [
  {
    name: 'Glassmorphism',
    aliases: ['1', 'glass', 'frosted'],
    keywords: ['glass', 'frosted', 'blur', 'translucent', 'saas', 'modern'],
    prompt: 'Frosted glass cards, backdrop-blur 12-20px, translucent overlays (10-30% opacity), subtle 1px light borders, layered depth, vibrant background.',
    tokens: '--blur: 16px; --glass: rgba(255,255,255,0.14); --radius: 16px;',
    avoid: 'Low-contrast text on glass, heavy blur on every surface, missing fallback without backdrop-filter.',
  },
  {
    name: 'Neumorphism',
    aliases: ['2', 'soft ui', 'embossed'],
    keywords: ['soft', 'wellness', 'health', 'meditation', 'pastel'],
    prompt: 'Soft 3D surfaces, pastel monochrome, 12-16px radius, dual light/dark shadows, press-in states at 150ms.',
    tokens: '--radius: 14px; --shadow-light: -6px -6px 16px rgba(255,255,255,0.7); --shadow-dark: 6px 6px 16px rgba(0,0,0,0.08);',
    avoid: 'Low-contrast text, complex dashboards, tiny controls.',
  },
  {
    name: 'Brutalism',
    aliases: ['3', 'raw', 'anti-design'],
    keywords: ['brutal', 'raw', 'stark', 'editorial', 'bold', 'asymmetric'],
    prompt: 'Raw high-contrast blocks, 0 radius, visible 2-4px borders, bold type 700+, instant transitions, primary red/blue/yellow + black/white.',
    tokens: '--radius: 0px; --border: 3px solid #000; --weight: 800;',
    avoid: 'Soft shadows, rounded corporate cards, timid greys.',
  },
  {
    name: 'Minimalist',
    aliases: ['4', 'minimal', 'swiss', 'clean'],
    keywords: ['minimal', 'clean', 'simple', 'swiss', 'enterprise', 'docs'],
    prompt: 'Swiss grid, generous whitespace, geometric sans, high contrast, essential elements only, almost no shadows or gradients.',
    tokens: '--radius: 0px; --space: 2rem; --shadow: none;',
    avoid: 'Decorative blobs, extra cards, cluttered nav.',
  },
  {
    name: 'Dark Mode',
    aliases: ['5', 'oled', 'dark'],
    keywords: ['dark', 'night', 'oled', 'coding', 'cinema', 'premium'],
    prompt: 'OLED dark (#000/#121212/#0A0E27), neon accents used sparingly, 7:1 text contrast, minimal glow, no large white surfaces.',
    tokens: '--bg: #0A0E17; --surface: #121826; --text: #F8FAFC; --accent: #38BDF8;',
    avoid: 'Pure white cards, faint grey body text, glow on every element.',
  },
  {
    name: 'Gradient Rich',
    aliases: ['6', 'aurora', 'mesh'],
    keywords: ['gradient', 'aurora', 'colorful', 'vibrant', 'music', 'lifestyle'],
    prompt: 'Mesh/aurora backgrounds, complementary blends, 8-12s slow motion, high-contrast type over darkened overlays.',
    tokens: '--grad: radial-gradient(at 20% 20%, #6366F1, transparent 40%), radial-gradient(at 80% 0%, #F43F5E, transparent 35%);',
    avoid: 'Text sitting on busy gradients without overlay, rainbow overload.',
  },
  {
    name: '3D Depth',
    aliases: ['7', '3d', 'dimensional'],
    keywords: ['3d', 'depth', 'product', 'showcase', 'immersive'],
    prompt: 'Layered depth, perspective, soft multi-shadows, parallax on 1-2 hero elements only, tactile cards. Prefer CSS 3D over WebGL unless asked.',
    tokens: '--perspective: 1000px; --elev-1: 0 8px 24px rgba(0,0,0,0.12);',
    avoid: 'WebGL on every section, animating layout properties.',
  },
  {
    name: 'Retro Wave',
    aliases: ['8', 'synthwave', 'cyberpunk', 'retro'],
    keywords: ['retro', '80s', 'neon', 'cyber', 'synth', 'game'],
    prompt: 'Synthwave/cyber look: deep navy/black, neon pink/cyan, glow text, geometric grids, optional scanlines, monospace accents.',
    tokens: '--bg: #0B0618; --neon: #FF2BD6; --cyan: #22D3EE;',
    avoid: 'Low-contrast neon on neon, endless glitch loops.',
  },
  {
    name: 'Flat Design',
    aliases: ['flat'],
    keywords: ['flat', 'startup', 'saas', 'dashboard', 'mvp'],
    prompt: '2D flat UI, 4-6 solid colors, no shadows/gradients, simple shapes, icon-led hierarchy, 150-200ms color/opacity hovers.',
    tokens: '--shadow: none; --radius: 8px;',
    avoid: 'Skeuomorphic textures, heavy glass.',
  },
];

const COLORS: ColorProfile[] = [
  { name: 'SaaS', keywords: ['saas', 'software', 'platform', 'b2b', 'tool'], primary: '#2563EB', accent: '#EA580C', background: '#F8FAFC', foreground: '#1E293B', notes: 'Trust blue + orange CTA' },
  { name: 'E-commerce', keywords: ['shop', 'store', 'ecommerce', 'product', 'cart'], primary: '#059669', accent: '#EA580C', background: '#ECFDF5', foreground: '#064E3B', notes: 'Success green + urgency orange' },
  { name: 'Luxury', keywords: ['luxury', 'fashion', 'spa', 'hotel', 'premium', 'beauty'], primary: '#1C1917', accent: '#A16207', background: '#FAFAF9', foreground: '#0C0A09', notes: 'Stone + gold' },
  { name: 'Healthcare', keywords: ['health', 'clinic', 'medical', 'wellness', 'hospital'], primary: '#0891B2', accent: '#059669', background: '#ECFEFF', foreground: '#164E63', notes: 'Calm cyan + health green' },
  { name: 'Creative', keywords: ['agency', 'studio', 'creative', 'portfolio', 'design'], primary: '#EC4899', accent: '#0891B2', background: '#FDF2F8', foreground: '#831843', notes: 'Bold pink + cyan' },
  { name: 'Fintech', keywords: ['bank', 'finance', 'fintech', 'crypto', 'trading'], primary: '#0F172A', accent: '#22C55E', background: '#020617', foreground: '#F8FAFC', notes: 'Dark navy + positive green' },
  { name: 'Education', keywords: ['school', 'learn', 'course', 'education', 'kids'], primary: '#4F46E5', accent: '#EA580C', background: '#EEF2FF', foreground: '#1E1B4B', notes: 'Indigo + energetic orange' },
  { name: 'Restaurant', keywords: ['food', 'restaurant', 'cafe', 'menu', 'kitchen'], primary: '#C2410C', accent: '#CA8A04', background: '#FFF7ED', foreground: '#431407', notes: 'Warm terracotta' },
  { name: 'Real Estate', keywords: ['real estate', 'property', 'home', 'architect'], primary: '#1E3A8A', accent: '#D97706', background: '#F8FAFC', foreground: '#1E3A8A', notes: 'Navy + amber' },
  { name: 'Gaming', keywords: ['game', 'esport', 'gaming', 'stream'], primary: '#7C3AED', accent: '#F43F5E', background: '#0F0F23', foreground: '#E2E8F0', notes: 'Neon purple + rose' },
];

const TYPEFACES: TypeProfile[] = [
  { name: 'Modern Professional', keywords: ['saas', 'business', 'corporate', 'startup'], heading: 'Poppins', body: 'Open Sans', importUrl: 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&family=Poppins:wght@500;600;700&display=swap' },
  { name: 'Tech Startup', keywords: ['tech', 'ai', 'developer', 'software'], heading: 'Space Grotesk', body: 'DM Sans', importUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap' },
  { name: 'Classic Elegant', keywords: ['luxury', 'fashion', 'spa', 'editorial', 'beauty'], heading: 'Playfair Display', body: 'Inter', importUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@500;600;700&display=swap' },
  { name: 'Playful Creative', keywords: ['kids', 'play', 'fun', 'game', 'education'], heading: 'Fredoka', body: 'Nunito', importUrl: 'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap' },
  { name: 'Minimal Swiss', keywords: ['minimal', 'dashboard', 'docs', 'clean'], heading: 'Inter', body: 'Inter', importUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' },
  { name: 'Wellness Calm', keywords: ['health', 'wellness', 'yoga', 'organic'], heading: 'Lora', body: 'Raleway', importUrl: 'https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Raleway:wght@400;500;600&display=swap' },
];

const LANDINGS: LandingProfile[] = [
  { name: 'Hero + Features + CTA', keywords: ['saas', 'startup', 'product', 'tool'], sections: '1. Hero 2. Value prop 3. 3-5 features 4. CTA 5. Footer', cta: 'Primary CTA in hero and again after features' },
  { name: 'Social Proof', keywords: ['agency', 'service', 'consult', 'clinic'], sections: '1. Hero 2. Problem 3. Solution 4. Testimonials 5. CTA', cta: 'CTA after 3-5 named testimonials' },
  { name: 'Menu / Catalog', keywords: ['restaurant', 'food', 'shop', 'store', 'menu'], sections: '1. Hero 2. Categories 3. Featured items 4. About 5. Contact/CTA', cta: 'Reserve / Shop CTA sticky on mobile' },
  { name: 'Portfolio', keywords: ['portfolio', 'studio', 'architect', 'photographer'], sections: '1. Name/hero 2. Selected work grid 3. About 4. Contact', cta: 'Contact after work, not before' },
  { name: 'Local Business', keywords: ['dentist', 'lawyer', 'salon', 'gym', 'hotel'], sections: '1. Hero 2. Services 3. Proof 4. Hours/map 5. Book CTA', cta: 'Book/call visible in header and footer' },
];

const UX_RULES = `
- Use Lucide or Heroicons only. Never use emoji as icons.
- cursor-pointer on every clickable control. Hover/focus in 150-300ms (opacity/color/transform, never width/height/top).
- Touch targets >= 44px. Visible :focus-visible rings. Labels on every input.
- Text contrast >= 4.5:1 (7:1 preferred). Do not rely on color alone.
- Respect prefers-reduced-motion. Max 1-2 motion moments per view.
- Mobile-first: 375 / 768 / 1024 / 1440. Sticky nav must not cover content (compensate padding).
- Smooth scroll. Active nav state. Skeleton/spinner for async work.
- Standard Tailwind classes only (bg-white, text-gray-900, bg-blue-600). No bg-background / text-foreground / bg-primary tokens.
- Import Google Fonts in index.html or index.css. Apply heading/body fonts consistently.
- Real content, not lorem. Distinct visual hierarchy. One primary CTA per section.
`.trim();

function scoreKeywords(text: string, keywords: string[]) {
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 2 : 0), 0);
}

function pickBest<T extends { keywords: string[] }>(items: T[], text: string, fallbackIndex = 0) {
  let best = items[fallbackIndex];
  let bestScore = -1;
  for (const item of items) {
    const score = scoreKeywords(text, item.keywords);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function pickStyle(text: string, styleHint?: string) {
  const hint = (styleHint || '').toLowerCase().trim();
  if (hint) {
    const exact = STYLES.find(
      (style) =>
        style.aliases.includes(hint) ||
        style.name.toLowerCase() === hint ||
        style.name.toLowerCase().includes(hint) ||
        hint.includes(style.name.toLowerCase())
    );
    if (exact) return exact;
  }
  return pickBest(STYLES, text, 0);
}

export function buildUiUxProMaxBrief(input: {
  prompt: string;
  styleHint?: string;
  isEdit?: boolean;
}) {
  const text = `${input.styleHint || ''} ${input.prompt || ''}`.toLowerCase();
  const style = pickStyle(text, input.styleHint);
  const colors = pickBest(COLORS, text, 0);
  const type = pickBest(TYPEFACES, text, 0);
  const landing = pickBest(LANDINGS, text, 0);

  if (input.isEdit) {
    return `
## UI/UX PRO MAX (PRESERVE DESIGN)
Keep the established visual system. Do not restyle the whole app.
- Preserve colors, type, radius, and spacing already in the files
- Only change what the user asked
- Still follow: Lucide/Heroicons (no emoji icons), 44px targets, 150-300ms hovers, 4.5:1 contrast, standard Tailwind classes
`.trim();
  }

  return `
## UI/UX PRO MAX DESIGN SYSTEM (MANDATORY FOR THIS CREATION)
This brief is generated at creation time from the user's request. Follow it as the source of truth.

### Style: ${style.name}
${style.prompt}
Tokens: ${style.tokens}
Do not: ${style.avoid}

### Color system: ${colors.name}
- Primary: ${colors.primary}
- Accent / CTA: ${colors.accent}
- Background: ${colors.background}
- Foreground: ${colors.foreground}
- Cards: white or 6-8% tinted surface, clear border
Notes: ${colors.notes}
Use these hex values in Tailwind arbitrary colors when needed (e.g. bg-[#2563EB]). Keep CTA contrast high.

### Typography: ${type.name}
- Headings: ${type.heading}
- Body: ${type.body}
- Import once: ${type.importUrl}
- Tight heading tracking, readable body 16px+, line-height 1.5-1.7

### Page structure: ${landing.name}
${landing.sections}
CTA: ${landing.cta}

### UX quality bar
${UX_RULES}

### Implementation checklist
- Header + nav, hero, 3-5 content sections, footer
- Responsive grid, consistent 8px spacing rhythm
- Hover, focus, and disabled states on interactive elements
- No placeholder grey boxes where real UI should exist
`.trim();
}
