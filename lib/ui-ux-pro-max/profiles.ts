/**
 * Vendored ui-ux-pro-max profiles, generated from the skill's CSV research data.
 * DO NOT EDIT BY HAND — run `node ./node_modules/tsx/dist/cli.mjs scripts/generate-ui-ux-profiles.ts`.
 * The skill data lives in .cursor/skills/ui-ux-pro-max/data/*.csv, which is not on a
 * deployed server and whose search.py needs Python. Keeping the breadth here lets the
 * runtime pick the right style without a CLI subprocess or a path that may not exist.
 */
export type SurfaceKind = 'light' | 'dark' | 'either';

export type StyleProfile = {
  name: string;
  type: string;
  keywords: string[];
  surface: SurfaceKind;
  prompt: string;
  tokens: string;
  avoid: string;
  bestFor: string;
  performance: string;
  accessibility: string;
  mobile: string;
  conversion: string;
};

export type TypeProfile = {
  name: string;
  keywords: string[];
  heading: string;
  body: string;
  importUrl: string;
  notes: string;
};

export type LandingProfile = {
  name: string;
  keywords: string[];
  sections: string;
  cta: string;
};

export const STYLE_PROFILES: StyleProfile[] = [
  {
    "name": "Minimalism & Swiss Style",
    "type": "General",
    "keywords": [
      "Clean",
      "simple",
      "spacious",
      "functional",
      "white space",
      "high contrast",
      "geometric",
      "sans-serif",
      "grid-based",
      "essential"
    ],
    "surface": "either",
    "prompt": "Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools",
    "tokens": "display: grid, gap: 2rem, font-family: sans-serif, color: #000 or #FFF, max-width: 1200px, clean borders, no box-shadow unless necessary",
    "avoid": "Creative portfolios, entertainment, playful brands, artistic experiments",
    "bestFor": "Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "◐ Medium"
  },
  {
    "name": "Neumorphism",
    "type": "General",
    "keywords": [
      "Soft UI",
      "embossed",
      "debossed",
      "convex",
      "concave",
      "light source",
      "subtle depth",
      "rounded (12-16px)",
      "monochromatic"
    ],
    "surface": "light",
    "prompt": "Soft box-shadow (multiple: -5px -5px 15px, 5px 5px 15px), smooth press (150ms), inner subtle shadow Health/wellness apps, meditation platforms, fitness trackers, minimal interaction UIs",
    "tokens": "border-radius: 12-16px, box-shadow: -5px -5px 15px rgba(0,0,0,0.1), 5px 5px 15px rgba(255,255,255,0.8), background: linear-gradient(145deg, color1, color2), transform: scale on press",
    "avoid": "Complex apps, critical accessibility, data-heavy dashboards, high-contrast required",
    "bestFor": "Health/wellness apps, meditation platforms, fitness trackers, minimal interaction UIs",
    "performance": "⚡ Good",
    "accessibility": "⚠ Low contrast",
    "mobile": "✓ Good",
    "conversion": "◐ Medium"
  },
  {
    "name": "Glassmorphism",
    "type": "General",
    "keywords": [
      "Frosted glass",
      "transparent",
      "blurred background",
      "layered",
      "vibrant background",
      "light source",
      "depth",
      "multi-layer"
    ],
    "surface": "either",
    "prompt": "Backdrop blur (10-20px), subtle border (1px solid rgba white 0.2), light reflection, Z-depth Modern SaaS, financial dashboards, high-end corporate, lifestyle apps, modal overlays, navigation",
    "tokens": "backdrop-filter: blur(15px), background: rgba(255, 255, 255, 0.15), border: 1px solid rgba(255,255,255,0.2), -webkit-backdrop-filter: blur(15px), z-index layering for depth",
    "avoid": "Low-contrast backgrounds, critical accessibility, performance-limited, dark text on dark",
    "bestFor": "Modern SaaS, financial dashboards, high-end corporate, lifestyle apps, modal overlays, navigation",
    "performance": "⚠ Good",
    "accessibility": "⚠ Ensure 4.5:1",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Brutalism",
    "type": "General",
    "keywords": [
      "Raw",
      "unpolished",
      "stark",
      "high contrast",
      "plain text",
      "default fonts",
      "visible borders",
      "asymmetric",
      "anti-design"
    ],
    "surface": "either",
    "prompt": "No smooth transitions (instant), sharp corners (0px), bold typography (700+), visible grid, large blocks Design portfolios, artistic projects, counter-culture brands, editorial/media sites, tech blogs",
    "tokens": "border-radius: 0px, transition: none or 0s, font-family: system-ui or monospace, font-weight: 700+, border: visible 2-4px, colors: #FF0000, #0000FF, #FFFF00, #000000, #FFFFFF",
    "avoid": "Corporate environments, conservative industries, critical accessibility, customer-facing professional",
    "bestFor": "Design portfolios, artistic projects, counter-culture brands, editorial/media sites, tech blogs",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "◐ Medium",
    "conversion": "✗ Low"
  },
  {
    "name": "3D & Hyperrealism",
    "type": "General",
    "keywords": [
      "Depth",
      "realistic textures",
      "3D models",
      "spatial navigation",
      "tactile",
      "skeuomorphic elements",
      "rich detail",
      "immersive"
    ],
    "surface": "light",
    "prompt": "WebGL/Three.js 3D, realistic shadows (layers), physics lighting, parallax (3-5 layers), smooth 3D (300-400ms) Gaming, product showcase, immersive experiences, high-end e-commerce, architectural viz, VR/AR",
    "tokens": "transform: translate3d, perspective: 1000px, WebGL canvas, Three.js/Babylon.js library, box-shadow: complex multi-layer, background: complex gradients, filter: drop-shadow()",
    "avoid": "Low-end mobile, performance-limited, critical accessibility, data tables/forms",
    "bestFor": "Gaming, product showcase, immersive experiences, high-end e-commerce, architectural viz, VR/AR",
    "performance": "❌ Poor",
    "accessibility": "⚠ Not accessible",
    "mobile": "✗ Low",
    "conversion": "◐ Medium"
  },
  {
    "name": "Vibrant & Block-based",
    "type": "General",
    "keywords": [
      "Bold",
      "energetic",
      "playful",
      "block layout",
      "geometric shapes",
      "high color contrast",
      "duotone",
      "modern",
      "energetic"
    ],
    "surface": "either",
    "prompt": "Large sections (48px+ gaps), animated patterns, bold hover (color shift), scroll-snap, large type (32px+), 200-300ms Startups, creative agencies, gaming, social media, youth-focused, entertainment, consumer",
    "tokens": "display: flex/grid with large gaps (48px+), font-size: 32px+, background: animated patterns (CSS), color: neon/vibrant colors, animation: continuous pattern movement",
    "avoid": "Financial institutions, healthcare, formal business, government, conservative, elderly",
    "bestFor": "Startups, creative agencies, gaming, social media, youth-focused, entertainment, consumer",
    "performance": "⚡ Good",
    "accessibility": "◐ Ensure WCAG",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Dark Mode (OLED)",
    "type": "General",
    "keywords": [
      "Dark theme",
      "low light",
      "high contrast",
      "deep black",
      "midnight blue",
      "eye-friendly",
      "OLED",
      "night mode",
      "power efficient"
    ],
    "surface": "dark",
    "prompt": "Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light",
    "tokens": "background: #000000 or #121212, color: #FFFFFF or #E0E0E0, text-shadow: 0 0 10px neon-color (sparingly), filter: brightness(0.8) if needed, color-scheme: dark",
    "avoid": "Print-first content, high-brightness outdoor, color-accuracy-critical",
    "bestFor": "Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "◐ Low"
  },
  {
    "name": "Accessible & Ethical",
    "type": "General",
    "keywords": [
      "High contrast",
      "large text (16px+)",
      "keyboard navigation",
      "screen reader friendly",
      "WCAG compliant",
      "focus state",
      "semantic"
    ],
    "surface": "either",
    "prompt": "Clear focus rings (3-4px), ARIA labels, skip links, responsive design, reduced motion, 44x44px touch targets Government, healthcare, education, inclusive products, large audience, legal compliance, public",
    "tokens": "color-contrast: 7:1+, font-size: 16px+, outline: 3-4px on :focus-visible, aria-label, role attributes, @media (prefers-reduced-motion), touch-target: 44x44px, cursor: pointer",
    "avoid": "None - accessibility universal",
    "bestFor": "Government, healthcare, education, inclusive products, large audience, legal compliance, public",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Claymorphism",
    "type": "General",
    "keywords": [
      "Soft 3D",
      "chunky",
      "playful",
      "toy-like",
      "bubbly",
      "thick borders (3-4px)",
      "double shadows",
      "rounded (16-24px)"
    ],
    "surface": "light",
    "prompt": "Inner+outer shadows (subtle, no hard lines), soft press (200ms ease-out), fluffy elements, smooth transitions Educational apps, children's apps, SaaS platforms, creative tools, fun-focused, onboarding, casual games",
    "tokens": "border-radius: 16-24px, border: 3-4px solid, box-shadow: inset -2px -2px 8px, 4px 4px 8px, background: pastel-gradient, animation: soft bounce (cubic-bezier 0.34, 1.56)",
    "avoid": "Formal corporate, professional services, data-critical, serious/medical, legal apps, finance",
    "bestFor": "Educational apps, children's apps, SaaS platforms, creative tools, fun-focused, onboarding, casual games",
    "performance": "⚡ Good",
    "accessibility": "⚠ Ensure 4.5:1",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Aurora UI",
    "type": "General",
    "keywords": [
      "Vibrant gradients",
      "smooth blend",
      "Northern Lights effect",
      "mesh gradient",
      "luminous",
      "atmospheric",
      "abstract"
    ],
    "surface": "either",
    "prompt": "Large flowing CSS/SVG gradients, subtle 8-12s animations, depth via color layering, smooth morph Modern SaaS, creative agencies, branding, music platforms, lifestyle, premium products, hero sections",
    "tokens": "background: conic-gradient or radial-gradient with multiple stops, animation: @keyframes gradient (8-12s), background-size: 200% 200%, filter: saturate(1.2), blend-mode: screen or multiply",
    "avoid": "Data-heavy dashboards, critical accessibility, content-heavy where distraction issues",
    "bestFor": "Modern SaaS, creative agencies, branding, music platforms, lifestyle, premium products, hero sections",
    "performance": "⚠ Good",
    "accessibility": "⚠ Text contrast",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Retro-Futurism",
    "type": "General",
    "keywords": [
      "Vintage sci-fi",
      "80s aesthetic",
      "neon glow",
      "geometric patterns",
      "CRT scanlines",
      "pixel art",
      "cyberpunk",
      "synthwave"
    ],
    "surface": "either",
    "prompt": "CRT scanlines (::before overlay), neon glow (text-shadow+box-shadow), glitch effects (skew/offset keyframes) Gaming, entertainment, music platforms, tech brands, artistic projects, nostalgic, cyberpunk",
    "tokens": "color: neon colors (#0080FF, #FF006E, #00FFFF), text-shadow: 0 0 10px neon, background: #000 or #1A1A2E, font-family: monospace, animation: glitch (skew+offset), filter: hue-rotate",
    "avoid": "Conservative industries, critical accessibility, professional/corporate, elderly, legal/finance",
    "bestFor": "Gaming, entertainment, music platforms, tech brands, artistic projects, nostalgic, cyberpunk",
    "performance": "⚠ Moderate",
    "accessibility": "⚠ High contrast/strain",
    "mobile": "◐ Medium",
    "conversion": "◐ Medium"
  },
  {
    "name": "Flat Design",
    "type": "General",
    "keywords": [
      "2D",
      "minimalist",
      "bold colors",
      "no shadows",
      "clean lines",
      "simple shapes",
      "typography-focused",
      "modern",
      "icon-heavy"
    ],
    "surface": "either",
    "prompt": "No gradients/shadows, simple hover (color/opacity shift), fast loading, clean transitions (150-200ms ease), minimal icons Web apps, mobile apps, cross-platform, startup MVPs, user-friendly, SaaS, dashboards, corporate",
    "tokens": "box-shadow: none, background: solid color, border-radius: 0-4px, color: solid (no gradients), fill: solid, stroke: 1-2px, font: bold sans-serif, icons: simplified SVG",
    "avoid": "Complex 3D, premium/luxury, artistic portfolios, immersive experiences, high-detail",
    "bestFor": "Web apps, mobile apps, cross-platform, startup MVPs, user-friendly, SaaS, dashboards, corporate",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Skeuomorphism",
    "type": "General",
    "keywords": [
      "Realistic",
      "texture",
      "depth",
      "3D appearance",
      "real-world metaphors",
      "shadows",
      "gradients",
      "tactile",
      "detailed",
      "material"
    ],
    "surface": "light",
    "prompt": "Realistic shadows (layers), depth (perspective), texture details (noise, grain), realistic animations (300-500ms) Legacy apps, gaming, immersive storytelling, premium products, luxury, realistic simulations, education",
    "tokens": "background: complex gradient (8-12 stops), box-shadow: realistic multi-layer, background-image: texture overlay (noise, grain), filter: drop-shadow, transform: scale on press (300-500ms)",
    "avoid": "Modern enterprise, critical accessibility, low-performance, web (use Flat/Modern)",
    "bestFor": "Legacy apps, gaming, immersive storytelling, premium products, luxury, realistic simulations, education",
    "performance": "❌ Poor",
    "accessibility": "⚠ Textures reduce readability",
    "mobile": "✗ Low",
    "conversion": "◐ Medium"
  },
  {
    "name": "Liquid Glass",
    "type": "General",
    "keywords": [
      "Flowing glass",
      "morphing",
      "smooth transitions",
      "fluid effects",
      "translucent",
      "animated blur",
      "iridescent",
      "chromatic aberration"
    ],
    "surface": "either",
    "prompt": "Morphing elements (SVG/CSS), fluid animations (400-600ms curves), dynamic blur (backdrop-filter), color transitions Premium SaaS, high-end e-commerce, creative platforms, branding experiences, luxury portfolios",
    "tokens": "animation: morphing SVG paths (400-600ms), backdrop-filter: blur + saturate, filter: hue-rotate + brightness, blend-mode: screen, background: iridescent gradient",
    "avoid": "Performance-limited, critical accessibility, complex data, budget projects",
    "bestFor": "Premium SaaS, high-end e-commerce, creative platforms, branding experiences, luxury portfolios",
    "performance": "⚠ Moderate-Poor",
    "accessibility": "⚠ Text contrast",
    "mobile": "◐ Medium",
    "conversion": "✓ High"
  },
  {
    "name": "Motion-Driven",
    "type": "General",
    "keywords": [
      "Animation-heavy",
      "microinteractions",
      "smooth transitions",
      "scroll effects",
      "parallax",
      "entrance anim",
      "page transitions"
    ],
    "surface": "either",
    "prompt": "Scroll anim (Intersection Observer), hover (300-400ms), entrance, parallax (3-5 layers), page transitions Portfolio sites, storytelling platforms, interactive experiences, entertainment apps, creative, SaaS",
    "tokens": "animation: @keyframes scroll-reveal, transform: translateY/X, Intersection Observer API, will-change: transform, scroll-behavior: smooth, animation-duration: 300-400ms",
    "avoid": "Data dashboards, critical accessibility, low-power devices, content-heavy, motion-sensitive",
    "bestFor": "Portfolio sites, storytelling platforms, interactive experiences, entertainment apps, creative, SaaS",
    "performance": "⚠ Good",
    "accessibility": "⚠ Prefers-reduced-motion",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Micro-interactions",
    "type": "General",
    "keywords": [
      "Small animations",
      "gesture-based",
      "tactile feedback",
      "subtle animations",
      "contextual interactions",
      "responsive"
    ],
    "surface": "either",
    "prompt": "Small hover (50-100ms), loading spinners, success/error state anim, gesture-triggered (swipe/pinch), haptic Mobile apps, touchscreen UIs, productivity tools, user-friendly, consumer apps, interactive components",
    "tokens": "animation: short 50-100ms, transition: hover states, @media (hover: hover) for desktop, :active for press, haptic-feedback CSS/API, loading animation smooth loop",
    "avoid": "Desktop-only, critical performance, accessibility-first (alternatives needed)",
    "bestFor": "Mobile apps, touchscreen UIs, productivity tools, user-friendly, consumer apps, interactive components",
    "performance": "⚡ Excellent",
    "accessibility": "✓ Good",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Inclusive Design",
    "type": "General",
    "keywords": [
      "Accessible",
      "color-blind friendly",
      "high contrast",
      "haptic feedback",
      "voice interaction",
      "screen reader",
      "WCAG AAA",
      "universal"
    ],
    "surface": "either",
    "prompt": "Haptic feedback (vibration), voice guidance, focus indicators (4px+ ring), motion options, alt content, semantic Public services, education, healthcare, finance, government, accessible consumer, inclusive",
    "tokens": "aria-* attributes complete, role attributes semantic, focus-visible: 3-4px ring, color-contrast: 7:1+, @media (prefers-reduced-motion), alt text on all images, form labels properly associated",
    "avoid": "None - accessibility universal",
    "bestFor": "Public services, education, healthcare, finance, government, accessible consumer, inclusive",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Zero Interface",
    "type": "General",
    "keywords": [
      "Minimal visible UI",
      "voice-first",
      "gesture-based",
      "AI-driven",
      "invisible controls",
      "predictive",
      "context-aware",
      "ambient"
    ],
    "surface": "either",
    "prompt": "Voice recognition UI, gesture detection, AI predictions (smooth reveal), progressive disclosure, smart suggestions Voice assistants, AI platforms, future-forward UX, smart home, contextual computing, ambient experiences",
    "tokens": "voice-commands: Web Speech API, gesture-detection: touch events, AI-predictions: hidden by default (reveal on hover), progressive-disclosure: show on demand, minimal UI visible",
    "avoid": "Complex workflows, data-entry heavy, traditional systems, legacy support, explicit control",
    "bestFor": "Voice assistants, AI platforms, future-forward UX, smart home, contextual computing, ambient experiences",
    "performance": "⚡ Excellent",
    "accessibility": "✓ Excellent",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Soft UI Evolution",
    "type": "General",
    "keywords": [
      "Evolved soft UI",
      "better contrast",
      "modern aesthetics",
      "subtle depth",
      "accessibility-focused",
      "improved shadows",
      "hybrid"
    ],
    "surface": "either",
    "prompt": "Improved shadows (softer than flat, clearer than neumorphism), modern (200-300ms), focus visible, WCAG AA/AAA Modern enterprise apps, SaaS platforms, health/wellness, modern business tools, professional, hybrid",
    "tokens": "box-shadow: softer multi-layer (0 2px 4px), background: improved contrast pastels, border-radius: 8-12px, animation: 200-300ms smooth, outline: 2-3px on focus, contrast: 4.5:1+",
    "avoid": "Extreme minimalism, critical performance, systems without modern OS",
    "bestFor": "Modern enterprise apps, SaaS platforms, health/wellness, modern business tools, professional, hybrid",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA+",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Hero-Centric Design",
    "type": "Landing Page",
    "keywords": [
      "Large hero section",
      "compelling headline",
      "high-contrast CTA",
      "product showcase",
      "value proposition",
      "hero image/video",
      "dramatic visual"
    ],
    "surface": "either",
    "prompt": "Smooth scroll reveal, fade-in animations on hero, subtle background parallax, CTA glow/pulse effect SaaS landing pages, product launches, service landing pages, B2B platforms, tech companies",
    "tokens": "min-height: 100vh, display: flex, align-items: center, background: linear-gradient or image, text-shadow for readability, max-width: 800px for text, button with hover scale (1.05)",
    "avoid": "Complex navigation, multi-page experiences, data-heavy applications",
    "bestFor": "SaaS landing pages, product launches, service landing pages, B2B platforms, tech companies",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Full",
    "conversion": "✓ Very High"
  },
  {
    "name": "Conversion-Optimized",
    "type": "Landing Page",
    "keywords": [
      "Form-focused",
      "minimalist design",
      "single CTA focus",
      "high contrast",
      "urgency elements",
      "trust signals",
      "social proof",
      "clear value"
    ],
    "surface": "either",
    "prompt": "Hover states on CTA (color shift, slight scale), form field focus animations, loading spinner, success feedback E-commerce product pages, free trial signups, lead generation, SaaS pricing pages, limited-time offers",
    "tokens": "form with focus states, input:focus ring, button: primary color high contrast, position: sticky for CTA, max-width: 600px for form, loading spinner, success/error states",
    "avoid": "Complex feature explanations, multi-product showcases, technical documentation",
    "bestFor": "E-commerce product pages, free trial signups, lead generation, SaaS pricing pages, limited-time offers",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Full (mobile-optimized)",
    "conversion": "✓ Very High"
  },
  {
    "name": "Feature-Rich Showcase",
    "type": "Landing Page",
    "keywords": [
      "Multiple feature sections",
      "grid layout",
      "benefit cards",
      "visual feature demonstrations",
      "interactive elements",
      "problem-solution pairs"
    ],
    "surface": "either",
    "prompt": "Card hover effects (lift/scale), icon animations on scroll, feature toggle animations, smooth section transitions Enterprise SaaS, software tools landing pages, platform services, complex product explanations, B2B products",
    "tokens": "display: grid, grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)), gap: 2rem, card hover effects (translateY -4px), icon containers, alternating background colors",
    "avoid": "Simple product pages, early-stage startups with few features, entertainment landing pages",
    "bestFor": "Enterprise SaaS, software tools landing pages, platform services, complex product explanations, B2B products",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Minimal & Direct",
    "type": "Landing Page",
    "keywords": [
      "Minimal text",
      "white space heavy",
      "single column layout",
      "direct messaging",
      "clean typography",
      "visual-centric",
      "fast-loading"
    ],
    "surface": "either",
    "prompt": "Very subtle hover effects, minimal animations, fast page load (no heavy animations), smooth scroll Simple service landing pages, indie products, consulting services, micro SaaS, freelancer portfolios",
    "tokens": "max-width: 680px, margin: 0 auto, padding: 4rem 2rem, font-size: 18-20px, line-height: 1.6, minimal animations, no box-shadow, clean borders only",
    "avoid": "Feature-heavy products, complex explanations, multi-product showcases",
    "bestFor": "Simple service landing pages, indie products, consulting services, micro SaaS, freelancer portfolios",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ Full",
    "conversion": "✓ High"
  },
  {
    "name": "Social Proof-Focused",
    "type": "Landing Page",
    "keywords": [
      "Testimonials prominent",
      "client logos displayed",
      "case studies sections",
      "reviews/ratings",
      "user avatars",
      "success metrics",
      "credibility markers"
    ],
    "surface": "either",
    "prompt": "Testimonial carousel animations, logo grid fade-in, stat counter animations (number count-up), review star ratings B2B SaaS, professional services, premium products, e-commerce conversion pages, established brands",
    "tokens": "testimonial cards with avatar, logo grid (grayscale filter), star rating SVGs, counter animations (count-up), blockquote styling, carousel for testimonials, metric cards",
    "avoid": "Startup MVPs, products without users, niche/experimental products",
    "bestFor": "B2B SaaS, professional services, premium products, e-commerce conversion pages, established brands",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Full",
    "conversion": "✓ High"
  },
  {
    "name": "Interactive Product Demo",
    "type": "Landing Page",
    "keywords": [
      "Embedded product mockup/video",
      "interactive elements",
      "product walkthrough",
      "step-by-step guides",
      "hover-to-reveal features",
      "embedded demos"
    ],
    "surface": "either",
    "prompt": "Product animation playback, step progression animations, hover reveal effects, smooth zoom on interaction SaaS platforms, tool/software products, productivity apps landing pages, developer tools, productivity software",
    "tokens": "video element with controls, position: relative for overlays, hover reveal (opacity transition), step indicators, modal for full demo, screenshot lightbox, play button overlay",
    "avoid": "Simple services, consulting, non-digital products, complexity-averse audiences",
    "bestFor": "SaaS platforms, tool/software products, productivity apps landing pages, developer tools, productivity software",
    "performance": "⚠ Good (video/interactive)",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Good",
    "conversion": "✓ Very High"
  },
  {
    "name": "Trust & Authority",
    "type": "Landing Page",
    "keywords": [
      "Certificates/badges displayed",
      "expert credentials",
      "case studies with metrics",
      "before/after comparisons",
      "industry recognition",
      "security badges"
    ],
    "surface": "either",
    "prompt": "Badge hover effects, metric pulse animations, certificate carousel, smooth stat reveal Healthcare/medical landing pages, financial services, enterprise software, premium/luxury products, legal services",
    "tokens": "badge grid layout, shield icons, lock icons for security, certificate styling, metric cards with icons, professional color scheme (blue/grey), subtle shadows for depth",
    "avoid": "Casual products, entertainment, viral/social-first products",
    "bestFor": "Healthcare/medical landing pages, financial services, enterprise software, premium/luxury products, legal services",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ Full",
    "conversion": "✓ High"
  },
  {
    "name": "Storytelling-Driven",
    "type": "Landing Page",
    "keywords": [
      "Narrative flow",
      "visual story progression",
      "section transitions",
      "consistent character/brand voice",
      "emotional messaging",
      "journey visualization"
    ],
    "surface": "either",
    "prompt": "Section-to-section animations, scroll-triggered reveals, character/icon animations, morphing transitions, parallax narrative Brand/startup stories, mission-driven products, premium/lifestyle brands, documentary-style products, educational",
    "tokens": "scroll-snap sections, Intersection Observer for reveals, parallax backgrounds, section transitions, timeline CSS, narrative typography (varied sizes), image-text alternating",
    "avoid": "Technical/complex products (unless narrative-driven), traditional enterprise software",
    "bestFor": "Brand/startup stories, mission-driven products, premium/lifestyle brands, documentary-style products, educational",
    "performance": "⚠ Moderate (animations)",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Data-Dense Dashboard",
    "type": "BI/Analytics",
    "keywords": [
      "Multiple charts/widgets",
      "data tables",
      "KPI cards",
      "minimal padding",
      "grid layout",
      "space-efficient",
      "maximum data visibility"
    ],
    "surface": "either",
    "prompt": "Hover tooltips, chart zoom on click, row highlighting on hover, smooth filter animations, data loading spinners Business intelligence dashboards, financial analytics, enterprise reporting, operational dashboards, data warehousing",
    "tokens": "display: grid, grid-template-columns: repeat(12, 1fr), gap: 8px, padding: 12px, font-size: 12-14px, overflow: auto for tables, compact card design, sticky headers",
    "avoid": "Marketing dashboards, consumer-facing analytics, simple reporting",
    "bestFor": "Business intelligence dashboards, financial analytics, enterprise reporting, operational dashboards, data warehousing",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Heat Map & Heatmap Style",
    "type": "BI/Analytics",
    "keywords": [
      "Color-coded grid/matrix",
      "data intensity visualization",
      "geographical heat maps",
      "correlation matrices",
      "cell-based representation",
      "gradient coloring"
    ],
    "surface": "either",
    "prompt": "Color gradient transitions on data change, cell highlighting on hover, tooltip reveal on click, smooth color animation Geographical analysis, performance matrices, correlation analysis, user behavior heatmaps, temperature/intensity data",
    "tokens": "display: grid, background: linear-gradient for legend, cell hover states, tooltip positioning, color scale (blue→white→red), SVG for geographic, canvas for large datasets",
    "avoid": "Linear data representation, categorical comparisons (use bar charts), small datasets",
    "bestFor": "Geographical analysis, performance matrices, correlation analysis, user behavior heatmaps, temperature/intensity data",
    "performance": "⚡ Excellent",
    "accessibility": "⚠ Colorblind considerations",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Executive Dashboard",
    "type": "BI/Analytics",
    "keywords": [
      "High-level KPIs",
      "large key metrics",
      "minimal detail",
      "summary view",
      "trend indicators",
      "at-a-glance insights",
      "executive summary"
    ],
    "surface": "either",
    "prompt": "KPI value animations (count-up), trend arrow direction animations, metric card hover lift, alert pulse effect C-suite dashboards, business summary reports, decision-maker dashboards, strategic planning views",
    "tokens": "display: flex for KPI row, large font-size (24-48px) for metrics, sparkline SVG inline, status indicators (border-left color), card shadows for hierarchy, responsive breakpoints",
    "avoid": "Detailed analyst dashboards, technical deep-dives, operational monitoring",
    "bestFor": "C-suite dashboards, business summary reports, decision-maker dashboards, strategic planning views",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✗ Low (not mobile-optimized)",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Real-Time Monitoring",
    "type": "BI/Analytics",
    "keywords": [
      "Live data updates",
      "status indicators",
      "alert notifications",
      "streaming data visualization",
      "active monitoring",
      "streaming charts"
    ],
    "surface": "either",
    "prompt": "Real-time chart animations, alert pulse/glow, status indicator blink animation, smooth data stream updates, loading effect System monitoring dashboards, DevOps dashboards, real-time analytics, stock market dashboards, live event tracking",
    "tokens": "animation: pulse for live, WebSocket for streaming, position: fixed for alerts, status-dot with animation, chart real-time updates, notification toast, connection indicator",
    "avoid": "Historical analysis, long-term trend reports, archived data dashboards",
    "bestFor": "System monitoring dashboards, DevOps dashboards, real-time analytics, stock market dashboards, live event tracking",
    "performance": "⚡ Good (real-time load)",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Drill-Down Analytics",
    "type": "BI/Analytics",
    "keywords": [
      "Hierarchical data exploration",
      "expandable sections",
      "interactive drill-down paths",
      "summary-to-detail flow",
      "context preservation"
    ],
    "surface": "either",
    "prompt": "Drill-down expand animations, breadcrumb click transitions, smooth detail reveal, level change smooth, data reload animation Sales analytics, product analytics, funnel analysis, multi-dimensional data exploration, business intelligence",
    "tokens": "breadcrumb nav with separators, details/summary for expand, transition for drill animation, position: sticky breadcrumb, nested grid layouts, smooth scroll to detail",
    "avoid": "Simple linear data, single-metric dashboards, streaming real-time dashboards",
    "bestFor": "Sales analytics, product analytics, funnel analysis, multi-dimensional data exploration, business intelligence",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Comparative Analysis Dashboard",
    "type": "BI/Analytics",
    "keywords": [
      "Side-by-side comparisons",
      "period-over-period metrics",
      "A/B test results",
      "regional comparisons",
      "performance benchmarks"
    ],
    "surface": "either",
    "prompt": "Comparison bar animations (grow to value), delta indicator animations (direction arrows), highlight on compare Period-over-period reporting, A/B test dashboards, market comparison, competitive analysis, regional performance",
    "tokens": "display: flex for side-by-side, gap for comparison spacing, color coding (green up, red down), arrow indicators, diff highlighting, comparison table zebra striping",
    "avoid": "Single metric dashboards, future projections (use forecasting), real-time only (no historical)",
    "bestFor": "Period-over-period reporting, A/B test dashboards, market comparison, competitive analysis, regional performance",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Predictive Analytics",
    "type": "BI/Analytics",
    "keywords": [
      "Forecast lines",
      "confidence intervals",
      "trend projections",
      "scenario modeling",
      "AI-driven insights",
      "anomaly detection visualization"
    ],
    "surface": "either",
    "prompt": "Forecast line animation on draw, confidence band fade-in, anomaly pulse alert, smoothing function animations Forecasting dashboards, anomaly detection systems, trend prediction dashboards, AI-powered analytics, budget planning",
    "tokens": "stroke-dasharray for forecast lines, fill-opacity for confidence bands, anomaly markers (circles), tooltip for predictions, toggle switches for scenarios, gradient for probability",
    "avoid": "Historical-only dashboards, simple reporting, real-time operational dashboards",
    "bestFor": "Forecasting dashboards, anomaly detection systems, trend prediction dashboards, AI-powered analytics, budget planning",
    "performance": "⚠ Good (computation)",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "User Behavior Analytics",
    "type": "BI/Analytics",
    "keywords": [
      "Funnel visualization",
      "user flow diagrams",
      "conversion tracking",
      "engagement metrics",
      "user journey mapping",
      "cohort analysis"
    ],
    "surface": "either",
    "prompt": "Funnel animation (fill-down), flow diagram animations (connection draw), conversion pulse, engagement bar fill Conversion funnel analysis, user journey tracking, engagement analytics, cohort analysis, retention tracking",
    "tokens": "SVG funnel with gradients, Sankey diagram library, percentage labels, cohort grid cells, retention chart (line/area), click heatmap overlay, session timeline",
    "avoid": "Real-time operational metrics, technical system monitoring, financial transactions",
    "bestFor": "Conversion funnel analysis, user journey tracking, engagement analytics, cohort analysis, retention tracking",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Good",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Financial Dashboard",
    "type": "BI/Analytics",
    "keywords": [
      "Revenue metrics",
      "profit/loss visualization",
      "budget tracking",
      "financial ratios",
      "portfolio performance",
      "cash flow",
      "audit trail"
    ],
    "surface": "either",
    "prompt": "Number animations (count-up), trend direction indicators, percentage change animations, profit/loss color transitions Financial reporting, accounting dashboards, portfolio tracking, budget monitoring, banking analytics",
    "tokens": "number formatting (Intl.NumberFormat), waterfall chart (positive/negative bars), variance coloring, table with totals row, sparkline for trends, sticky column headers",
    "avoid": "Simple business dashboards, entertainment/social metrics, non-financial data",
    "bestFor": "Financial reporting, accounting dashboards, portfolio tracking, budget monitoring, banking analytics",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✗ Low",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Sales Intelligence Dashboard",
    "type": "BI/Analytics",
    "keywords": [
      "Deal pipeline",
      "sales metrics",
      "territory performance",
      "sales rep leaderboard",
      "win-loss analysis",
      "quota tracking",
      "forecast accuracy"
    ],
    "surface": "either",
    "prompt": "Deal movement animations, metric updates, leaderboard ranking changes, gauge needle movements, status change highlights CRM dashboards, sales management, opportunity tracking, performance management, quota planning",
    "tokens": "kanban columns (flex), gauge chart (SVG arc), leaderboard ranking styles, map integration (Mapbox/Google), timeline vertical, deal card with status border",
    "avoid": "Marketing analytics, customer support metrics, HR dashboards",
    "bestFor": "CRM dashboards, sales management, opportunity tracking, performance management, quota planning",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "◐ Medium",
    "conversion": "✗ Not applicable"
  },
  {
    "name": "Neubrutalism",
    "type": "General",
    "keywords": [
      "Bold borders",
      "black outlines",
      "primary colors",
      "thick shadows",
      "no gradients",
      "flat colors",
      "45° shadows",
      "playful",
      "Gen Z"
    ],
    "surface": "either",
    "prompt": "box-shadow: 4px 4px 0 #000, border: 3px solid #000, no gradients, sharp corners (0px), bold typography Gen Z brands, startups, creative agencies, Figma-style apps, Notion-style interfaces, tech blogs",
    "tokens": "border: 3px solid black, box-shadow: 5px 5px 0px black, colors: #FFDB58 #FF6B6B #4ECDC4, font-weight: 700, no gradients",
    "avoid": "Luxury brands, finance, healthcare, conservative industries (too playful)",
    "bestFor": "Gen Z brands, startups, creative agencies, Figma-style apps, Notion-style interfaces, tech blogs",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Bento Box Grid",
    "type": "General",
    "keywords": [
      "Modular cards",
      "asymmetric grid",
      "varied sizes",
      "Apple-style",
      "dashboard tiles",
      "negative space",
      "clean hierarchy",
      "cards"
    ],
    "surface": "either",
    "prompt": "grid-template with varied spans, rounded-xl (16px), subtle shadows, hover scale (1.02), smooth transitions Dashboards, product pages, portfolios, Apple-style marketing, feature showcases, SaaS",
    "tokens": "display: grid, grid-template-columns: repeat(4, 1fr), grid-auto-rows: 200px, gap: 16px, border-radius: 24px, background: #FFFFFF, box-shadow: 0 4px 6px rgba(0,0,0,0.05)",
    "avoid": "Dense data tables, text-heavy content, real-time monitoring",
    "bestFor": "Dashboards, product pages, portfolios, Apple-style marketing, feature showcases, SaaS",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Y2K Aesthetic",
    "type": "General",
    "keywords": [
      "Neon pink",
      "chrome",
      "metallic",
      "bubblegum",
      "iridescent",
      "glossy",
      "retro-futurism",
      "2000s",
      "futuristic nostalgia"
    ],
    "surface": "light",
    "prompt": "linear-gradient metallic, glossy buttons, 3D chrome effects, glow animations, bubble shapes Fashion brands, music platforms, Gen Z brands, nostalgia marketing, entertainment, youth-focused",
    "tokens": "background: linear-gradient(135deg, #FF69B4, #00FFFF), filter: drop-shadow for glow, border-radius: 50% for bubbles, metallic gradients (silver/chrome), text-shadow: neon glow, ::before for sparkles",
    "avoid": "B2B enterprise, healthcare, finance, conservative industries, elderly users",
    "bestFor": "Fashion brands, music platforms, Gen Z brands, nostalgia marketing, entertainment, youth-focused",
    "performance": "⚠ Good",
    "accessibility": "⚠ Check contrast",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Cyberpunk UI",
    "type": "General",
    "keywords": [
      "Neon",
      "dark mode",
      "terminal",
      "HUD",
      "sci-fi",
      "glitch",
      "dystopian",
      "futuristic",
      "matrix",
      "tech noir"
    ],
    "surface": "dark",
    "prompt": "Neon glow (text-shadow), glitch animations (skew/offset), scanlines (::before overlay), terminal fonts Gaming platforms, tech products, crypto apps, sci-fi applications, developer tools, entertainment",
    "tokens": "background: #0D0D0D, color: #00FF00 or #FF00FF, font-family: monospace, text-shadow: 0 0 10px neon, animation: glitch (transform skew), ::before scanlines (repeating-linear-gradient)",
    "avoid": "Corporate enterprise, healthcare, family apps, conservative brands, elderly users",
    "bestFor": "Gaming platforms, tech products, crypto apps, sci-fi applications, developer tools, entertainment",
    "performance": "⚠ Moderate",
    "accessibility": "⚠ Limited (dark+neon)",
    "mobile": "◐ Medium",
    "conversion": "◐ Medium"
  },
  {
    "name": "Organic Biophilic",
    "type": "General",
    "keywords": [
      "Nature",
      "organic shapes",
      "green",
      "sustainable",
      "rounded",
      "flowing",
      "wellness",
      "earthy",
      "natural textures"
    ],
    "surface": "either",
    "prompt": "Rounded corners (16-24px), organic curves (border-radius variations), natural shadows, flowing SVG shapes Wellness apps, sustainability brands, eco products, health apps, meditation, organic food brands",
    "tokens": "border-radius: 16-24px (varied), background: earth tones, SVG organic shapes (blob), box-shadow: natural soft, color: #228B22 #8B4513 #87CEEB, texture overlays (subtle)",
    "avoid": "Tech-focused products, gaming, industrial, urban brands",
    "bestFor": "Wellness apps, sustainability brands, eco products, health apps, meditation, organic food brands",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "AI-Native UI",
    "type": "General",
    "keywords": [
      "Chatbot",
      "conversational",
      "voice",
      "assistant",
      "agentic",
      "ambient",
      "minimal chrome",
      "streaming text",
      "AI interactions"
    ],
    "surface": "either",
    "prompt": "Typing indicators (3-dot pulse), streaming text animations, pulse animations, context cards, smooth reveals AI products, chatbots, voice assistants, copilots, AI-powered tools, conversational interfaces",
    "tokens": "chat bubble layout (flex-direction: column), typing animation (3 dots pulse), streaming text (overflow: hidden + animation), input: sticky bottom, context cards (border-left accent), minimal borders",
    "avoid": "Traditional forms, data-heavy dashboards, print-first content",
    "bestFor": "AI products, chatbots, voice assistants, copilots, AI-powered tools, conversational interfaces",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Memphis Design",
    "type": "General",
    "keywords": [
      "80s",
      "geometric",
      "playful",
      "postmodern",
      "shapes",
      "patterns",
      "squiggles",
      "triangles",
      "neon",
      "abstract",
      "bold"
    ],
    "surface": "either",
    "prompt": "transform: rotate(), clip-path: polygon(), mix-blend-mode, repeating patterns, bold shapes Creative agencies, music sites, youth brands, event promotion, artistic portfolios, entertainment",
    "tokens": "clip-path: polygon() for shapes, background: repeating patterns, transform: rotate() for tilted elements, mix-blend-mode for overlays, border: dashed/dotted patterns, bold sans-serif",
    "avoid": "Corporate finance, healthcare, legal, elderly users, conservative brands",
    "bestFor": "Creative agencies, music sites, youth brands, event promotion, artistic portfolios, entertainment",
    "performance": "⚡ Excellent",
    "accessibility": "⚠ Check contrast",
    "mobile": "✓ Good",
    "conversion": "◐ Medium"
  },
  {
    "name": "Vaporwave",
    "type": "General",
    "keywords": [
      "Synthwave",
      "retro-futuristic",
      "80s-90s",
      "neon",
      "glitch",
      "nostalgic",
      "sunset gradient",
      "dreamy",
      "aesthetic"
    ],
    "surface": "either",
    "prompt": "text-shadow glow, linear-gradient, filter: hue-rotate(), glitch animations, retro scan lines Music platforms, gaming, creative portfolios, tech startups, entertainment, artistic projects",
    "tokens": "background: linear-gradient(180deg, #FF71CE, #01CDFE, #B967FF), filter: hue-rotate(), text-shadow: neon glow, retro grid (perspective + linear-gradient), VHS scanlines",
    "avoid": "Business apps, e-commerce, education, healthcare, enterprise software",
    "bestFor": "Music platforms, gaming, creative portfolios, tech startups, entertainment, artistic projects",
    "performance": "⚠ Moderate",
    "accessibility": "⚠ Poor (motion)",
    "mobile": "◐ Medium",
    "conversion": "◐ Medium"
  },
  {
    "name": "Dimensional Layering",
    "type": "General",
    "keywords": [
      "Depth",
      "overlapping",
      "z-index",
      "layers",
      "3D",
      "shadows",
      "elevation",
      "floating",
      "cards",
      "spatial hierarchy"
    ],
    "surface": "either",
    "prompt": "z-index stacking, box-shadow elevation (4 levels), transform: translateZ(), backdrop-filter, parallax Dashboards, card layouts, modals, navigation, product showcases, SaaS interfaces",
    "tokens": "z-index: 1-4 levels, box-shadow: elevation scale (sm/md/lg/xl), transform: translateZ(), backdrop-filter: blur(), position: relative for stacking, parallax on scroll",
    "avoid": "Print-style layouts, simple blogs, low-end devices, flat design requirements",
    "bestFor": "Dashboards, card layouts, modals, navigation, product showcases, SaaS interfaces",
    "performance": "⚠ Good",
    "accessibility": "⚠ Moderate (SR issues)",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Exaggerated Minimalism",
    "type": "General",
    "keywords": [
      "Bold minimalism",
      "oversized typography",
      "high contrast",
      "negative space",
      "loud minimal",
      "statement design"
    ],
    "surface": "either",
    "prompt": "font-size: clamp(3rem 10vw 12rem), font-weight: 900, letter-spacing: -0.05em, massive whitespace Fashion, architecture, portfolios, agency landing pages, luxury brands, editorial",
    "tokens": "font-size: clamp(3rem, 10vw, 12rem), font-weight: 900, letter-spacing: -0.05em, color: #000 or #FFF, padding: 8rem+, single accent, no decorations",
    "avoid": "E-commerce catalogs, dashboards, forms, data-heavy, elderly users, complex apps",
    "bestFor": "Fashion, architecture, portfolios, agency landing pages, luxury brands, editorial",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Kinetic Typography",
    "type": "General",
    "keywords": [
      "Motion text",
      "animated type",
      "moving letters",
      "dynamic",
      "typing effect",
      "morphing",
      "scroll-triggered text"
    ],
    "surface": "either",
    "prompt": "@keyframes text animation, typing effect, background-clip: text, GSAP ScrollTrigger, split text Hero sections, marketing sites, video platforms, storytelling, creative portfolios, landing pages",
    "tokens": "@keyframes for text animation, background-clip: text, GSAP SplitText, typing effect (steps()), transform on letters, scroll-triggered (Intersection Observer), variable fonts for morphing",
    "avoid": "Long-form content, accessibility-critical, data interfaces, forms, elderly users",
    "bestFor": "Hero sections, marketing sites, video platforms, storytelling, creative portfolios, landing pages",
    "performance": "⚠ Moderate",
    "accessibility": "❌ Poor (motion)",
    "mobile": "✓ Good",
    "conversion": "✓ Very High"
  },
  {
    "name": "Parallax Storytelling",
    "type": "General",
    "keywords": [
      "Scroll-driven",
      "narrative",
      "layered scrolling",
      "immersive",
      "progressive disclosure",
      "cinematic",
      "scroll-triggered"
    ],
    "surface": "either",
    "prompt": "transform: translateY(scroll), position: fixed/sticky, perspective: 1px, scroll-triggered animations Brand storytelling, product launches, case studies, portfolios, annual reports, marketing campaigns",
    "tokens": "position: fixed/sticky, transform: translateY(calc()), perspective: 1px, z-index layering, scroll-snap-type, Intersection Observer for triggers, will-change: transform",
    "avoid": "E-commerce, dashboards, mobile-first, SEO-critical, accessibility-required",
    "bestFor": "Brand storytelling, product launches, case studies, portfolios, annual reports, marketing campaigns",
    "performance": "❌ Poor",
    "accessibility": "❌ Poor (motion)",
    "mobile": "✗ Low",
    "conversion": "✓ High"
  },
  {
    "name": "Swiss Modernism 2.0",
    "type": "General",
    "keywords": [
      "Grid system",
      "Helvetica",
      "modular",
      "asymmetric",
      "international style",
      "rational",
      "clean",
      "mathematical spacing"
    ],
    "surface": "either",
    "prompt": "display: grid, grid-template-columns: repeat(12 1fr), gap: 1rem, mathematical ratios, clear hierarchy Corporate sites, architecture, editorial, SaaS, museums, professional services, documentation",
    "tokens": "display: grid, grid-template-columns: repeat(12, 1fr), gap: 1rem (8px base unit), font-family: Inter/Helvetica, font-weight: 400-700, color: #000/#FFF, single accent",
    "avoid": "Playful brands, children's sites, entertainment, gaming, emotional storytelling",
    "bestFor": "Corporate sites, architecture, editorial, SaaS, museums, professional services, documentation",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "HUD / Sci-Fi FUI",
    "type": "General",
    "keywords": [
      "Futuristic",
      "technical",
      "wireframe",
      "neon",
      "data",
      "transparency",
      "iron man",
      "sci-fi",
      "interface"
    ],
    "surface": "either",
    "prompt": "Glow effects, scanning animations, ticker text, blinking markers, fine line drawing Sci-fi games, space tech, cybersecurity, movie props, immersive dashboards",
    "tokens": "border: 1px solid rgba(0,255,255,0.5), color: #00FFFF, background: transparent or rgba(0,0,0,0.8), font-family: monospace, text-shadow: 0 0 5px cyan",
    "avoid": "Standard corporate, reading heavy content, accessible public services",
    "bestFor": "Sci-fi games, space tech, cybersecurity, movie props, immersive dashboards",
    "performance": "⚠ Moderate (renders)",
    "accessibility": "⚠ Poor (thin lines)",
    "mobile": "◐ Medium",
    "conversion": "✗ Low"
  },
  {
    "name": "Pixel Art",
    "type": "General",
    "keywords": [
      "Retro",
      "8-bit",
      "16-bit",
      "gaming",
      "blocky",
      "nostalgic",
      "pixelated",
      "arcade"
    ],
    "surface": "either",
    "prompt": "Frame-by-frame sprite animation, blinking cursor, instant transitions, marquee text Indie games, retro tools, creative portfolios, nostalgia marketing, Web3/NFT",
    "tokens": "font-family: 'Press Start 2P', image-rendering: pixelated, box-shadow: 4px 0 0 #000 (pixel border), no anti-aliasing",
    "avoid": "Professional corporate, modern SaaS, high-res photography sites",
    "bestFor": "Indie games, retro tools, creative portfolios, nostalgia marketing, Web3/NFT",
    "performance": "⚡ Excellent",
    "accessibility": "✓ Good (if contrast ok)",
    "mobile": "✓ High",
    "conversion": "◐ Medium"
  },
  {
    "name": "Bento Grids",
    "type": "General",
    "keywords": [
      "Apple-style",
      "modular",
      "cards",
      "organized",
      "clean",
      "hierarchy",
      "grid",
      "rounded",
      "soft"
    ],
    "surface": "either",
    "prompt": "Hover scale (1.02), soft shadow expansion, smooth layout shifts, content reveal Product features, dashboards, personal sites, marketing summaries, galleries",
    "tokens": "display: grid, grid-template-columns: repeat(auto-fit, minmax(...)), gap: 1rem, border-radius: 20px, background: #FFF, box-shadow: subtle",
    "avoid": "Long-form reading, data tables, complex forms",
    "bestFor": "Product features, dashboards, personal sites, marketing summaries, galleries",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Spatial UI (VisionOS)",
    "type": "General",
    "keywords": [
      "Glass",
      "depth",
      "immersion",
      "spatial",
      "translucent",
      "gaze",
      "gesture",
      "apple",
      "vision-pro"
    ],
    "surface": "either",
    "prompt": "Parallax depth, dynamic lighting response, gaze-hover effects, smooth scale on focus Spatial computing apps, VR/AR interfaces, immersive media, futuristic dashboards",
    "tokens": "backdrop-filter: blur(40px) saturate(180%), background: rgba(255,255,255,0.2), border-radius: 24px, box-shadow: 0 8px 32px rgba(0,0,0,0.1), transform: scale on focus, depth via shadows",
    "avoid": "Text-heavy documents, high-contrast requirements, non-3D capable devices",
    "bestFor": "Spatial computing apps, VR/AR interfaces, immersive media, futuristic dashboards",
    "performance": "⚠ Moderate (blur cost)",
    "accessibility": "⚠ Contrast risks",
    "mobile": "✓ High (if adapted)",
    "conversion": "✓ High"
  },
  {
    "name": "E-Ink / Paper",
    "type": "General",
    "keywords": [
      "Paper-like",
      "matte",
      "high contrast",
      "texture",
      "reading",
      "calm",
      "slow tech",
      "monochrome"
    ],
    "surface": "light",
    "prompt": "No motion blur, distinct page turns, grain/noise texture, sharp transitions (no fade) Reading apps, digital newspapers, minimal journals, distraction-free writing, slow-living brands",
    "tokens": "background: #FDFBF7 (paper white), color: #1A1A1A, transition: none, font-family: serif for reading, no gradients, border: 1px solid #E0E0E0, texture overlay (noise)",
    "avoid": "Gaming, video platforms, high-energy marketing, dark mode dependent apps",
    "bestFor": "Reading apps, digital newspapers, minimal journals, distraction-free writing, slow-living brands",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ Medium"
  },
  {
    "name": "Gen Z Chaos / Maximalism",
    "type": "General",
    "keywords": [
      "Chaos",
      "clutter",
      "stickers",
      "raw",
      "collage",
      "mixed media",
      "loud",
      "internet culture",
      "ironic"
    ],
    "surface": "either",
    "prompt": "Marquee scrolls, jitter, sticker layering, GIF overload, random placement, drag-and-drop Gen Z lifestyle brands, music artists, creative portfolios, viral marketing, fashion",
    "tokens": "mix-blend-mode: multiply/screen, transform: rotate(random), animation: jitter, marquee text, position: absolute for scattered elements, filter: saturate(150%), z-index chaos",
    "avoid": "Corporate, government, healthcare, banking, serious tools",
    "bestFor": "Gen Z lifestyle brands, music artists, creative portfolios, viral marketing, fashion",
    "performance": "⚠ Poor (heavy assets)",
    "accessibility": "❌ Poor",
    "mobile": "◐ Medium",
    "conversion": "✓ High (Viral)"
  },
  {
    "name": "Biomimetic / Organic 2.0",
    "type": "General",
    "keywords": [
      "Nature-inspired",
      "cellular",
      "fluid",
      "breathing",
      "generative",
      "algorithms",
      "life-like"
    ],
    "surface": "either",
    "prompt": "Breathing animations, fluid morphing, generative growth, physics-based movement Sustainability tech, biotech, advanced health, meditation, generative art platforms",
    "tokens": "SVG morphing (SMIL or GSAP), canvas for generative, animation: breathing (scale pulse), filter: blur for organic, clip-path for cellular, WebGL for advanced, physics libraries",
    "avoid": "Standard SaaS, data grids, strict corporate, accounting",
    "bestFor": "Sustainability tech, biotech, advanced health, meditation, generative art platforms",
    "performance": "⚠ Moderate",
    "accessibility": "✓ Good",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Anti-Polish / Raw Aesthetic",
    "type": "General",
    "keywords": [
      "Hand-drawn",
      "collage",
      "scanned textures",
      "unfinished",
      "imperfect",
      "authentic",
      "human",
      "sketch",
      "raw marks",
      "creative process"
    ],
    "surface": "either",
    "prompt": "No smooth transitions, hand-drawn animations, paper texture overlays, jitter effects, sketch reveal Creative portfolios, artist sites, indie brands, handmade products, authentic storytelling, editorial",
    "tokens": "background: url(paper-texture.png), filter: grayscale() contrast(), border: hand-drawn SVG, transform: rotate(small random), no smooth transitions, sketch-style fonts, opacity variations",
    "avoid": "Corporate enterprise, fintech, healthcare, government, polished SaaS",
    "bestFor": "Creative portfolios, artist sites, indie brands, handmade products, authentic storytelling, editorial",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Tactile Digital / Deformable UI",
    "type": "General",
    "keywords": [
      "Jelly buttons",
      "chrome",
      "clay",
      "squishy",
      "deformable",
      "bouncy",
      "physical",
      "tactile feedback",
      "press response"
    ],
    "surface": "either",
    "prompt": "Press deformation (scale + squish), bounce-back (cubic-bezier), material response, haptic-like feedback, spring physics Modern mobile apps, playful brands, entertainment, gaming UI, consumer products, interactive demos",
    "tokens": "transform: scale(0.95) on active, animation: bounce (cubic-bezier(0.34, 1.56, 0.64, 1)), box-shadow: inset for press, filter: brightness on press, spring physics (react-spring/framer-motion)",
    "avoid": "Enterprise software, data dashboards, accessibility-critical, professional tools",
    "bestFor": "Modern mobile apps, playful brands, entertainment, gaming UI, consumer products, interactive demos",
    "performance": "⚠ Good",
    "accessibility": "⚠ Motion sensitive",
    "mobile": "✓ High",
    "conversion": "✓ Very High"
  },
  {
    "name": "Nature Distilled",
    "type": "General",
    "keywords": [
      "Muted earthy",
      "skin tones",
      "wood",
      "soil",
      "sand",
      "terracotta",
      "warmth",
      "organic materials",
      "handmade warmth"
    ],
    "surface": "light",
    "prompt": "Subtle parallax, natural easing (ease-out), texture overlays, grain effects, soft shadows Wellness brands, sustainable products, artisan goods, organic food, spa/beauty, home decor",
    "tokens": "background: warm earth tones, color: #C67B5C #D4C4A8 #6B7B3C, border-radius: organic (varied), box-shadow: soft natural, texture overlays (grain), font: humanist sans-serif",
    "avoid": "Tech startups, gaming, nightlife, corporate finance, high-energy brands",
    "bestFor": "Wellness brands, sustainable products, artisan goods, organic food, spa/beauty, home decor",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Interactive Cursor Design",
    "type": "General",
    "keywords": [
      "Custom cursor",
      "cursor as tool",
      "hover effects",
      "cursor feedback",
      "pointer transformation",
      "cursor trail",
      "magnetic cursor"
    ],
    "surface": "either",
    "prompt": "Cursor scale on hover, magnetic pull to elements, cursor morphing, trail effects, blend mode cursors, click feedback Creative portfolios, interactive experiences, agency sites, product showcases, gaming, entertainment",
    "tokens": "cursor: none (custom), position: fixed for cursor element, mix-blend-mode: difference, transform on hover targets, magnetic effect (JS position lerp), trail with opacity fade, scale on click",
    "avoid": "Mobile-first (no cursor), accessibility-critical, data-heavy dashboards, forms",
    "bestFor": "Creative portfolios, interactive experiences, agency sites, product showcases, gaming, entertainment",
    "performance": "⚡ Good",
    "accessibility": "⚠ Not for touch/SR",
    "mobile": "✗ No cursor",
    "conversion": "✓ High"
  },
  {
    "name": "Voice-First Multimodal",
    "type": "General",
    "keywords": [
      "Voice UI",
      "multimodal",
      "audio feedback",
      "conversational",
      "hands-free",
      "ambient",
      "contextual",
      "speech recognition"
    ],
    "surface": "either",
    "prompt": "Voice waveform visualization, listening pulse, processing spinner, speak animation, smooth transitions Voice assistants, accessibility apps, hands-free tools, smart home, automotive UI, cooking apps",
    "tokens": "Web Speech API integration, canvas for waveform, animation: pulse for listening, status indicators (color change), audio visualization (Web Audio API), minimal chrome, large touch targets",
    "avoid": "Visual-heavy content, data entry, complex forms, noisy environments",
    "bestFor": "Voice assistants, accessibility apps, hands-free tools, smart home, automotive UI, cooking apps",
    "performance": "⚡ Excellent",
    "accessibility": "✓ Excellent",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "3D Product Preview",
    "type": "General",
    "keywords": [
      "360 product view",
      "rotatable",
      "zoomable",
      "touch-to-spin",
      "AR preview",
      "product configurator",
      "interactive 3D model"
    ],
    "surface": "light",
    "prompt": "Drag-to-rotate, pinch-to-zoom, spin animation, AR placement, material switching, smooth orbit controls E-commerce, furniture, fashion, automotive, electronics, jewelry, product configurators",
    "tokens": "Three.js or model-viewer, OrbitControls, touch events for rotation, WebXR for AR, canvas with WebGL, loading placeholder, LOD for performance, environment lighting",
    "avoid": "Content-heavy sites, blogs, dashboards, low-bandwidth, accessibility-critical",
    "bestFor": "E-commerce, furniture, fashion, automotive, electronics, jewelry, product configurators",
    "performance": "❌ Poor (3D rendering)",
    "accessibility": "⚠ Alt content needed",
    "mobile": "◐ Medium",
    "conversion": "✓ Very High"
  },
  {
    "name": "Gradient Mesh / Aurora Evolved",
    "type": "General",
    "keywords": [
      "Complex gradients",
      "mesh gradients",
      "multi-color blend",
      "aurora effect",
      "flowing colors",
      "iridescent",
      "holographic",
      "prismatic"
    ],
    "surface": "either",
    "prompt": "CSS mesh-gradient (experimental), SVG gradients, canvas gradients, smooth color morphing, flowing animation Hero sections, backgrounds, creative brands, music platforms, fashion, lifestyle, premium products",
    "tokens": "background: conic-gradient or mesh (SVG), animation: gradient flow (background-position), filter: hue-rotate for shimmer, mix-blend-mode: screen, canvas for complex mesh, multiple gradient layers",
    "avoid": "Data interfaces, text-heavy content, accessibility-critical, conservative brands",
    "bestFor": "Hero sections, backgrounds, creative brands, music platforms, fashion, lifestyle, premium products",
    "performance": "⚠ Good",
    "accessibility": "⚠ Text contrast",
    "mobile": "✓ Good",
    "conversion": "✓ High"
  },
  {
    "name": "Editorial Grid / Magazine",
    "type": "General",
    "keywords": [
      "Magazine layout",
      "asymmetric grid",
      "editorial typography",
      "pull quotes",
      "drop caps",
      "column layout",
      "print-inspired"
    ],
    "surface": "either",
    "prompt": "Smooth scroll, reveal on scroll, parallax images, text animations, page-flip transitions News sites, blogs, magazines, editorial content, long-form articles, journalism, publishing",
    "tokens": "display: grid with named areas, column-count for text, ::first-letter for drop caps, blockquote styling, figure/figcaption, gap variations, font: serif for body, variable widths",
    "avoid": "Dashboards, apps, e-commerce catalogs, real-time data, short-form content",
    "bestFor": "News sites, blogs, magazines, editorial content, long-form articles, journalism, publishing",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA",
    "mobile": "✓ High",
    "conversion": "✓ Medium"
  },
  {
    "name": "Chromatic Aberration / RGB Split",
    "type": "General",
    "keywords": [
      "RGB split",
      "color fringing",
      "glitch",
      "retro tech",
      "VHS",
      "analog error",
      "distortion",
      "lens effect"
    ],
    "surface": "either",
    "prompt": "RGB offset animation, glitch timing, scan line movement, noise flicker, distortion on hover Music platforms, gaming, tech brands, creative portfolios, nightlife, entertainment, video platforms",
    "tokens": "filter: drop-shadow with offset colors, text-shadow: RGB offset (-2px 0 red, 2px 0 cyan), animation: glitch (random offset), ::before for scanlines, mix-blend-mode: screen for overlays",
    "avoid": "Corporate, healthcare, finance, accessibility-critical, elderly users",
    "bestFor": "Music platforms, gaming, tech brands, creative portfolios, nightlife, entertainment, video platforms",
    "performance": "⚠ Good",
    "accessibility": "⚠ Can cause strain",
    "mobile": "◐ Medium",
    "conversion": "✓ High"
  },
  {
    "name": "Vintage Analog / Retro Film",
    "type": "General",
    "keywords": [
      "Film grain",
      "VHS",
      "cassette tape",
      "polaroid",
      "analog warmth",
      "faded colors",
      "light leaks",
      "vintage photography"
    ],
    "surface": "light",
    "prompt": "Film grain overlay, VHS tracking effect, polaroid shake, fade-in transitions, light leak animations Photography portfolios, music/vinyl brands, vintage fashion, nostalgia marketing, film industry, cafes",
    "tokens": "filter: sepia() contrast() saturate(0.8), background: noise texture overlay, animation: VHS tracking (transform skew), light leak gradient overlay, border for polaroid frame, grain via SVG filter",
    "avoid": "Modern tech, SaaS, healthcare, children's apps, corporate enterprise",
    "bestFor": "Photography portfolios, music/vinyl brands, vintage fashion, nostalgia marketing, film industry, cafes",
    "performance": "⚡ Good",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ High",
    "conversion": "✓ High"
  },
  {
    "name": "Bauhaus (包豪斯)",
    "type": "Mobile",
    "keywords": [
      "bauhaus",
      "geometric",
      "constructivist",
      "primary colors",
      "hard shadow",
      "bold",
      "tactile",
      "functional",
      "poster",
      "mechanical",
      "architectural"
    ],
    "surface": "light",
    "prompt": "Hard offset shadows (4px 4px 0px black), mechanical press active:translate, no smooth hover — instant 0ms transitions, dot grid pattern on sections, slide-over transitions Mobile-first apps needing high personality, onboarding flows, branding-forward product screens, artisan/design brands, editorial mobile experiences",
    "tokens": "border-radius: 0px (cards/inputs) or 9999px (buttons/FAB), box-shadow: 4px 4px 0px 0px #121212, active:translate-x-[2px] active:translate-y-[2px] active:shadow-none, border: 2px solid #121212, font-family: Outfit, font-weight: 900 uppercase tracking-tighter (headlines)",
    "avoid": "Enterprise dashboards, accessibility-critical contexts (requires extra a11y work), data-heavy screens, conservative industries",
    "bestFor": "Mobile-first apps needing high personality, onboarding flows, branding-forward product screens, artisan/design brands, editorial mobile experiences",
    "performance": "⚡ Excellent",
    "accessibility": "⚠ WCAG AA (high contrast primaries; verify yellow text separately)",
    "mobile": "✓ Mobile-First",
    "conversion": "◐ Medium"
  },
  {
    "name": "Minimalist Monochrome",
    "type": "Mobile",
    "keywords": [
      "monochrome",
      "black white",
      "editorial",
      "austere",
      "typographic",
      "sharp",
      "zero radius",
      "high contrast",
      "brutalist",
      "pocket editorial",
      "serif",
      "mechanical"
    ],
    "surface": "light",
    "prompt": "Instant inversion active state (tap → bg-black text-white, zero transition-none), no shadows (strictly 2D), full-bleed horizontal rules (4px black section dividers), subtle paper noise texture (opacity: 0.03), slide-in page transitions with hard edge Luxury fashion e-commerce mobile, editorial publications, high-end portfolio apps, experimental/avant-garde brands, digital exhibitions",
    "tokens": "border-radius: 0px (ALL elements including modals), box-shadow: none, active:bg-black active:text-white transition-none, border-b-4 border-black (section dividers), divide-y divide-black (lists), font-family: Playfair Display (headers) + Source Serif 4 (body) + JetBrains Mono (labels), background-image: noise SVG opacity-[0.03]",
    "avoid": "Entertainment, colorful brands, friendly consumer apps, anything requiring visual warmth or gradient",
    "bestFor": "Luxury fashion e-commerce mobile, editorial publications, high-end portfolio apps, experimental/avant-garde brands, digital exhibitions",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AAA (pure black/white)",
    "mobile": "✓ Mobile-First",
    "conversion": "◐ Medium"
  },
  {
    "name": "Modern Dark (Cinema Mobile)",
    "type": "Mobile",
    "keywords": [
      "dark mode",
      "cinematic",
      "ambient light",
      "glassmorphism",
      "deep black",
      "indigo",
      "glow",
      "blur",
      "atmospheric",
      "reanimated",
      "haptic",
      "premium",
      "layered",
      "frosted glass",
      "linear gradient"
    ],
    "surface": "either",
    "prompt": "Expo.out Bezier(0.16,1,0.3,1) easing; spring modals (damping:20 stiffness:90); haptic-linked press (Impact Light/Medium); animated ambient light blobs (Reanimated translateX/Y slow oscillation); BlurView glassmorphism headers/nav (intensity 20); scale press 0.97 → 1.0; avoid pure #000000 (OLED smear) Developer tools, pro productivity apps, fintech/trading dashboards, media/streaming platforms, AI tool interfaces, high-end gaming companion apps",
    "tokens": "borderRadius: 16 (cards/buttons), background: LinearGradient #0a0a0f→#020203, border: StyleSheet.hairlineWidth rgba(255,255,255,0.08), BlurView intensity={20} tint='dark', useAnimatedStyle + withRepeat (blob oscillation), Easing.bezier(0.16,1,0.3,1), withSpring damping:20 stiffness:90, Haptics.impactAsync(ImpactFeedbackStyle.Light), scale: 0.97 press",
    "avoid": "Consumer apps needing warmth, children's apps, health/medical contexts where dark feels harsh, high-accessibility contexts needing maximum contrast",
    "bestFor": "Developer tools, pro productivity apps, fintech/trading dashboards, media/streaming platforms, AI tool interfaces, high-end gaming companion apps",
    "performance": "⚠ Good (blur effects require native driver)",
    "accessibility": "⚠ WCAG AA (requires careful accent contrast check)",
    "mobile": "✓ Mobile-First",
    "conversion": "◐ Medium"
  },
  {
    "name": "SaaS Mobile (High-Tech Boutique)",
    "type": "Mobile",
    "keywords": [
      "saas",
      "electric blue",
      "gradient",
      "fintech",
      "spring animation",
      "dual font",
      "glassmorphism",
      "boutique",
      "premium",
      "calistoga",
      "inter",
      "mono",
      "tactile",
      "haptic",
      "bento"
    ],
    "surface": "light",
    "prompt": "Spring animations (mass:1 damping:15 stiffness:120); gradient buttons (0052FF→4D7CFF); scale press 0.96→1.0 with haptics; floating FAB with gentle bobbing (Reanimated); glassmorphism BlurView navigation bars; staggered fade-in entrance (Y:20→0 + opacity:0→1); pulsing status dot on section badges; layout transitions (LayoutAnimation or Reanimated entering) B2B SaaS mobile dashboards, fintech apps, developer tool mobile companions, marketing analytics apps, HR/operations apps, modern business productivity",
    "tokens": "borderRadius: 16 (buttons/cards), LinearGradient colors={['#0052FF','#4D7CFF']}, shadowOpacity: 0.1, shadowRadius: 10, elevation: 4, Haptics.impactAsync(ImpactFeedbackStyle.Light) on press, withSpring({mass:1, damping:15, stiffness:120}), withTiming Y:20→0 opacity:0→1 staggered entrance, LayoutAnimation.configureNext for list updates, BlurView on nav bars",
    "avoid": "Pure consumer entertainment, children's apps, highly decorative lifestyle apps, contexts where Electric Blue feels too corporate",
    "bestFor": "B2B SaaS mobile dashboards, fintech apps, developer tool mobile companions, marketing analytics apps, HR/operations apps, modern business productivity",
    "performance": "⚡ Excellent",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Terminal CLI (Mobile)",
    "type": "Mobile",
    "keywords": [
      "terminal",
      "cli",
      "matrix green",
      "monospace",
      "hacker",
      "ascii",
      "command line",
      "developer",
      "web3",
      "crypto",
      "sci-fi",
      "OLED",
      "retro-future",
      "field operative"
    ],
    "surface": "dark",
    "prompt": "Blinking cursor (500ms opacity loop), typewriter text reveal hook, scanline overlay (repeating lines 0.05 opacity), ASCII art headers, instant color inversion on press (bg-green text-black), haptic on every keystroke, boot sequence splash on launch Developer tools, Web3/blockchain apps, geek-culture apps, ARG games, sci-fi/noir gaming companions, hacker/security tools, creative studio portfolios",
    "tokens": "borderRadius: 0 (ALL elements), borderWidth: 1, borderColor: '#33FF00', backgroundColor: '#050505', color: '#33FF00', fontFamily: 'SpaceMono-Regular' or JetBrains Mono, fontSize: 12 or 14 or 16 only, lineHeight: 1.2x fontSize, Haptics.impactAsync(Light) on every press, useAnimatedValue blink 500ms, hitSlop: 12px all sides for bracketed buttons",
    "avoid": "Consumer products, health apps, anything requiring approachability or warmth, children's apps, standard enterprise contexts",
    "bestFor": "Developer tools, Web3/blockchain apps, geek-culture apps, ARG games, sci-fi/noir gaming companions, hacker/security tools, creative studio portfolios",
    "performance": "⚡ Excellent",
    "accessibility": "✓ High contrast (green on black ≫4.5:1 ratio)",
    "mobile": "✓ Mobile-First (OLED optimized)",
    "conversion": "✗ Low"
  },
  {
    "name": "Kinetic Brutalism (Mobile)",
    "type": "Mobile",
    "keywords": [
      "kinetic",
      "brutalism",
      "motion",
      "marquee",
      "acid yellow",
      "uppercase",
      "oversized",
      "aggressive typography",
      "street",
      "zine",
      "high contrast",
      "scroll-driven",
      "haptic",
      "reanimated"
    ],
    "surface": "light",
    "prompt": "Infinite marquee (Reanimated, Linear easing, 5s loop, hard clip), hero parallax (scale 1.0→1.3 + fade), sticky section header push, card flood inversion on press (bg→#DFE104, text→#000000), haptic Medium on every press, scroll-triggered interpolate transforms, 0px radius, 2px borders, 100ms color transitions Immersive storytelling apps, brand flagship mobile, music/culture platforms, sports apps, underground zines, limited-edition product drops, performance dashboards",
    "tokens": "borderRadius: 0, borderWidth: 2, borderColor: '#3F3F46', backgroundColor: '#09090B', color: '#FAFAFA', fontWeight: '800 or 900', letterSpacing: -1 (large) or 2 (labels), lineHeight: 0.9–1.1 * fontSize, Reanimated withRepeat marquee timing 5000ms Easing.linear, Interpolate scroll→scale + opacity, Haptics.impactAsync(Medium), scale press: 0.95, 100ms color transitions",
    "avoid": "Calm informational apps, healthcare, finance contexts needing trust, children's, any context where aggressive typography feels inappropriate",
    "bestFor": "Immersive storytelling apps, brand flagship mobile, music/culture platforms, sports apps, underground zines, limited-edition product drops, performance dashboards",
    "performance": "⚡ Excellent (native driver required)",
    "accessibility": "⚠ WCAG AA (verify zinc body text on dark bg)",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High energy"
  },
  {
    "name": "Flat Design Mobile (Touch-First)",
    "type": "Mobile",
    "keywords": [
      "flat",
      "2D",
      "no shadow",
      "color blocking",
      "geometric",
      "bold",
      "poster",
      "icon",
      "touch-first",
      "minimal",
      "clean",
      "tailored",
      "cross-platform"
    ],
    "surface": "light",
    "prompt": "Immediate press feedback (scale 0.97, no delay), color section blocking (full-width contrasting View), zero elevation/shadow, solid icon containers (colored squares/circles), geometric low-opacity shape overlays, bottom tabs solid fill (no floating) Cross-platform apps (iOS+Android parity), information-dense dashboards, system UI, brand illustration, onboarding flows, marketing pages, icon design",
    "tokens": "shadowOpacity: 0, elevation: 0, borderRadius: 6/12/999, height: 48 minimum touch targets, spacing: 4/8/16/24/32/48 system, backgroundColor (section blocking), Pressable scale: pressed ? 0.97 : 1, fontWeight: '800' heads / '600' sub / '400' body, letterSpacing: -0.5 heads / 1 labels, textTransform: 'uppercase' labels, strokeWidth={2.5} icons, borderWidth: 3/4 for featured CTAs",
    "avoid": "Ultra-premium contexts needing depth/shadow, dark-mode-first products, contexts where flat design reads as unfinished or sterile",
    "bestFor": "Cross-platform apps (iOS+Android parity), information-dense dashboards, system UI, brand illustration, onboarding flows, marketing pages, icon design",
    "performance": "⚡ Excellent (no GPU effects)",
    "accessibility": "✓ WCAG AA (large bold type helps)",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Material You (MD3 Mobile)",
    "type": "Mobile",
    "keywords": [
      "material design 3",
      "md3",
      "tonal surfaces",
      "pills",
      "soft curves",
      "android",
      "md3 easing",
      "state layers",
      "haptic",
      "fab",
      "google"
    ],
    "surface": "either",
    "prompt": "Tonal elevation (overlay colors instead of strong shadows), pill-shaped buttons and chips (borderRadius 999), emphasized easing Easing.bezier(0.2,0,0,1), state layers (pressed overlays 10–15% opacity), Reanimated-filled label float for inputs, HapticFeedback on FAB/toggles Android ecosystem apps, cross-platform productivity tools, MD3-based admin panels, data-heavy back-office UI with Material UI",
    "tokens": "borderRadius: 999 (buttons/chips), containerRadius: 16–28, backgroundColor: '#FFFBFE', colorPrimary: '#6750A4', colorSecondaryContainer: '#E8DEF8', colorSurfaceContainer: '#F3EDF7', outlineColor: '#79747E', Pressable state-layer overlay (opacity 0.1–0.15), Easing.bezier(0.2,0,0,1), HapticFeedback.impactMedium on FAB, floating label using Reanimated translateY/scale",
    "avoid": "Ultra-minimal brutalist brands, terminal/hacker aesthetics, monochrome editorial apps",
    "bestFor": "Android ecosystem apps, cross-platform productivity tools, MD3-based admin panels, data-heavy back-office UI with Material UI",
    "performance": "⚠ Good (requires gradients and overlays)",
    "accessibility": "✓ WCAG AA (with MD3 token checks)",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Neo Brutalism (Mobile)",
    "type": "Mobile",
    "keywords": [
      "neo brutalism",
      "pop art",
      "stickers",
      "thick borders",
      "cream background",
      "hot red",
      "vivid yellow",
      "soft violet",
      "hard offset shadow",
      "mechanical press",
      "collage"
    ],
    "surface": "light",
    "prompt": "Thick 4px black borders on all major elements, hard offset shadows (4–8px, no blur), mechanical press: translateX/Y equal to shadow offset, slightly rotated cards/badges (-2deg/2deg), high-saturation color blocking, spring/linear animations only Creative tools, collab platforms, Gen Z marketing & e-commerce, portfolio sites, sticker-book style content apps",
    "tokens": "borderWidth: 4 (primary), 2 (secondary), borderRadius: 0 or 999 (badges only), backgroundColor: '#FFFDF5', shadow implemented as offset View, transform: [{translateX:4},{translateY:4}] on PressIn, fontFamily: 'SpaceGrotesk-Bold', fontWeight: '700/900', transform: [{ rotate: '-1deg' }] on cards, padding: 20",
    "avoid": "Serious enterprise apps, conservative industries, sober fintech, accessibility-first contexts (must tune contrast)",
    "bestFor": "Creative tools, collab platforms, Gen Z marketing & e-commerce, portfolio sites, sticker-book style content apps",
    "performance": "⚠ Moderate (shadows + transforms)",
    "accessibility": "⚠ Requires careful contrast tuning",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Bold Typography (Mobile Poster)",
    "type": "Mobile",
    "keywords": [
      "bold typography",
      "editorial",
      "poster",
      "broadsheet",
      "vermillion",
      "negative space",
      "edge-to-edge type",
      "underline CTA",
      "near-black",
      "warm white"
    ],
    "surface": "light",
    "prompt": "Hero headlines 48–72px (5:1 vs body size), tight tracking (-1.5px), edge-to-edge type, massive vertical spacing (60px+), underline CTAs (2–3px accent line), instant 200ms transitions (no bounce), strictly 0px radius containers, color shifts for active state instead of elevation Creative brand heroes, reading-focused apps, event/exhibition pages, editorial mobile experiences, landing hero sections",
    "tokens": "backgroundColor: '#0A0A0A', color: '#FAFAFA', accent: '#FF3D00', borderColor: '#262626', borderRadius: 0, paddingHorizontal: 24, headline style: fontSize:56–72, fontWeight:'700/800', letterSpacing:-1.5, lineHeight:1.1*fontSize, body: fontSize:16–18, lineHeight:1.6*fontSize, underline CTA: 2–3px height View under text, transition: 200ms cubic-bezier(0.25,0,0,1)",
    "avoid": "Utility dashboards, kids apps, playful consumer products, contexts needing many icons or heavy imagery",
    "bestFor": "Creative brand heroes, reading-focused apps, event/exhibition pages, editorial mobile experiences, landing hero sections",
    "performance": "⚡ Excellent",
    "accessibility": "✓ Contrast 18:1 achievable",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Academia (Scholarly Mobile)",
    "type": "Mobile",
    "keywords": [
      "academia",
      "library",
      "mahogany",
      "parchment",
      "brass",
      "crimson",
      "serif",
      "drop cap",
      "arch-top",
      "vignette",
      "leather",
      "scholarly",
      "tactile"
    ],
    "surface": "light",
    "prompt": "Deep mahogany backgrounds, oak surface cards, brass accented CTAs, arch-top hero/imagery, heavy vignette overlays, sepia-tinted images, drop caps with brass Cinzel, Roman numeral volume headings, slow timing-based animations (Easing.out poly(4)), zero neon or modern tech cues Knowledge management apps, deep reading tools, ritual-heavy personal brands, lore-heavy RPG/roleplay apps, culture-specific community platforms",
    "tokens": "backgroundColor: '#1C1714', altSurface: '#251E19', textColor: '#E8DFD4', mutedBg: '#3D332B', borderColor: '#4A3F35', brass: '#C9A962', crimson: '#8B2635', borderRadius: 4 (default), archTopRadius: 100 for hero, shadowOpacity:0.4 shadowRadius:6 elevation:8 for cards, textShadow on headings, vignette overlay via LinearGradient",
    "avoid": "Hyper-modern tech dashboards, neon/glassmorphism, playful Gen Z branding",
    "bestFor": "Knowledge management apps, deep reading tools, ritual-heavy personal brands, lore-heavy RPG/roleplay apps, culture-specific community platforms",
    "performance": "⚠ Moderate (vignette + shadows)",
    "accessibility": "✓ Legible (serif optimized)",
    "mobile": "◐ Mobile-First",
    "conversion": "◐ Medium"
  },
  {
    "name": "Cyberpunk Mobile HUD",
    "type": "Mobile",
    "keywords": [
      "cyberpunk",
      "neon",
      "glitch",
      "chamfered",
      "orbitron",
      "jetbrains",
      "scanlines",
      "crt",
      "hud",
      "matrix",
      "military",
      "decker"
    ],
    "surface": "dark",
    "prompt": "Deep void background with neon radiance, chamfered 45° corners via SVG/Skia, scanline overlay, CRT flicker opacity oscillation, glitch animations (translateX ±2), neon pulses around buttons, HUD corner brackets, terminal prompt text inputs, heavy use of blurView holographic panels Gaming dashboards, crypto/cyberpunk apps, sci-fi companion tools, hacker OS skins, data-heavy monitoring HUDs",
    "tokens": "backgroundColor: '#0A0A0F', cardBg: '#12121A', accent: '#00FF88', accent2: '#FF00FF', accent3: '#00D4FF', borderColor: '#2A2A3A', destructive: '#FF3366', borderRadius: 0, chamfer via SVG path, shadowColor accent with animated radius, scanline overlay View pointerEvents='none', withRepeat glitch translateX [-2,2,0], Easing.steps(2)",
    "avoid": "Serious enterprise, health/finance requiring calm trust, minimal editorial apps",
    "bestFor": "Gaming dashboards, crypto/cyberpunk apps, sci-fi companion tools, hacker OS skins, data-heavy monitoring HUDs",
    "performance": "⚠ Moderate–Heavy (Skia/blur/animations)",
    "accessibility": "⚠ Requires careful reduced-motion handling",
    "mobile": "✓ Mobile-First HUD",
    "conversion": "✓ High"
  },
  {
    "name": "Bitcoin DeFi (Mobile)",
    "type": "Mobile",
    "keywords": [
      "web3",
      "bitcoin",
      "defi",
      "digital gold",
      "fintech",
      "wallet",
      "orange",
      "glassmorphism",
      "gradient",
      "blur",
      "holographic",
      "trust",
      "precision"
    ],
    "surface": "dark",
    "prompt": "Deep void + dark matter surfaces, Bitcoin orange/gold gradients for CTAs, pill buttons with glowing shadows, glassmorphic BlurView nav, monospace data rows, gradient text balances + masked orange-gold, pulsing status indicators and vertical ledger timelines, ultra-thin borders, high-precision typography DeFi dashboards, wallets, NFT marketplaces, Web3 social, metaverse utilities, high-tech fintech brands",
    "tokens": "backgroundColor: '#030304', cardBg: '#0F1115', textColor: '#FFFFFF', mutedText: '#94A3B8', borderColor: 'rgba(30,41,59,0.2)', accentBitcoin: '#F7931A', accentBurnt: '#EA580C', accentGold: '#FFD600', borderRadius: 24 for cards, radiusPill: 999 for buttons, BlurView intensity 20, LinearGradient on CTAs, shadowColor '#F7931A' shadowRadius up to 10, JetBrains Mono for numeric text",
    "avoid": "Playful casual apps, low-tech brands, ultra-minimal editorial apps",
    "bestFor": "DeFi dashboards, wallets, NFT marketplaces, Web3 social, metaverse utilities, high-tech fintech brands",
    "performance": "⚠ Moderate (gradients+blur)",
    "accessibility": "✓ WCAG AA with care",
    "mobile": "✓ Mobile-First",
    "conversion": "✓ High"
  },
  {
    "name": "Claymorphism (Mobile)",
    "type": "Mobile",
    "keywords": [
      "claymorphism",
      "clay",
      "3d",
      "soft",
      "bubbly",
      "candy",
      "playful",
      "rounded",
      "squish",
      "tactile",
      "inflate",
      "silicone",
      "haptic",
      "spring"
    ],
    "surface": "light",
    "prompt": "Multi-layer shadow stacks (nested View) to simulate clay depth, LinearGradient #A78BFA→#7C3AED buttons, borderRadius 40–50 outer / 32 cards / 20 buttons, Reanimated spring squish (scale 0.92 on press), BlurView glass-clay hybrid cards, floating blobs with slow ±20px drift, Haptics Light on every press Children education apps, teen social products, crypto gamification, creative tools, brand mascot-led apps",
    "tokens": "backgroundColor: '#F4F1FA', cardBg: 'rgba(255,255,255,0.7)', textPrimary: '#332F3A', textMuted: '#635F69', accentPrimary: '#7C3AED', accentSecondary: '#DB2777', success: '#10B981', warning: '#F59E0B', radiusOuter: 50, radiusCard: 32, radiusButton: 20, shadowStack: 'nested View', gradientButton: ['#A78BFA', '#7C3AED'], springDamping: 10",
    "avoid": "Serious enterprise, high-density data, editorial reading apps, fintech trust signals",
    "bestFor": "Children education apps, teen social products, crypto gamification, creative tools, brand mascot-led apps",
    "performance": "⚠ Moderate–Heavy (shadows+blur)",
    "accessibility": "✓ WCAG AA (careful)",
    "mobile": "✓ Mobile-First (thumb zone)",
    "conversion": "✓ High"
  },
  {
    "name": "Enterprise SaaS (Mobile)",
    "type": "Mobile",
    "keywords": [
      "enterprise",
      "saas",
      "b2b",
      "professional",
      "indigo",
      "violet",
      "gradient",
      "polished",
      "trustworthy",
      "clean",
      "approachable",
      "spring",
      "haptic"
    ],
    "surface": "either",
    "prompt": "Indigo→Violet gradient primary CTAs + active tab highlights, colored card shadows rgba(79,70,229,0.08), pill buttons or 12pt radius, full-width CTA at screen bottom, spring press scale 0.97, floating label inputs with animated focus border, skeletal loading pulses (Indigo/Slate tint), Bottom Sheets with drag dismiss, swipe-to-action list cards, scroll-linked title collapse B2B backend management, productivity tools, government and finance mobile apps, SaaS companion apps, enterprise dashboards",
    "tokens": "backgroundColor: '#F8FAFC', surfaceBg: '#FFFFFF', textPrimary: '#0F172A', textMuted: '#64748B', primary: '#4F46E5', secondary: '#7C3AED', success: '#10B981', border: '#E2E8F0', radiusCard: 16, radiusButton: 999, radiusInput: 8, shadowCard: 'rgba(79,70,229,0.08)', gradientPrimary: ['#4F46E5', '#7C3AED'], screenPadding: 20",
    "avoid": "Pure consumer entertainment, Gen-Z youth apps, gaming UI, ultra-minimal editorial",
    "bestFor": "B2B backend management, productivity tools, government and finance mobile apps, SaaS companion apps, enterprise dashboards",
    "performance": "✓ Performant",
    "accessibility": "✓ WCAG AA",
    "mobile": "✓ Mobile-First (Safe Area strict)",
    "conversion": "✓ High"
  },
  {
    "name": "Sketch Hand-Drawn (Mobile)",
    "type": "Mobile",
    "keywords": [
      "sketch",
      "hand-drawn",
      "handwriting",
      "wobbly",
      "imperfect",
      "paper",
      "kalam",
      "organic",
      "collage",
      "post-it",
      "tape",
      "offset shadow",
      "scribble"
    ],
    "surface": "light",
    "prompt": "Wobbly borderRadius (unique per corner: 15/25/20/10), borderWidth 2–3 solid/dashed, hard offset shadow via rear View (4px,4px) #2D2D2D, Kalam Bold headings, PatrickHand Regular body, slight rotation (-1deg/1deg) on cards, absolute SVG scribble overlays (arrows/tape/tacks), jiggle -2deg↔2deg on error, LayoutAnimation spring on layout changes, Haptics on press, paper texture repeating background Low-fidelity prototyping, creative brands, children/picturebook apps, education tools, journaling apps, gamified puzzles",
    "tokens": "backgroundColor: '#FDFBF7', cardBg: '#FFFFFF', textPrimary: '#2D2D2D', accentRed: '#FF4D4D', accentBlue: '#2D5DA1', accentYellow: '#FFF9C4', border: '#2D2D2D', shadowView: 'offset 4px 4px #2D2D2D', wobblyRadius: [15,25,20,10], fontHeading: 'Kalam-Bold', fontBody: 'PatrickHand-Regular'",
    "avoid": "Enterprise dashboards, high-density data tables, fintech precision tools, medical or legal apps",
    "bestFor": "Low-fidelity prototyping, creative brands, children/picturebook apps, education tools, journaling apps, gamified puzzles",
    "performance": "✓ Lightweight",
    "accessibility": "⚠ Moderate (small/muted text risk)",
    "mobile": "✓ Mobile-First (wobbly touch targets 48x48)",
    "conversion": "✗ Low-Conversion"
  },
  {
    "name": "Neumorphism (Mobile)",
    "type": "Mobile",
    "keywords": [
      "neumorphism",
      "soft ui",
      "dual shadow",
      "extruded",
      "inset",
      "clay surface",
      "monochromatic",
      "cool grey",
      "haptic",
      "ceramic",
      "physical",
      "depth"
    ],
    "surface": "light",
    "prompt": "Full-screen #E0E5EC base, dual-layer shadow via nested View (light top-left + dark bottom-right), extruded convex resting state, inset concave pressed/input state, Reanimated scale 0.97 on press, shadow opacity interpolates 1→0.4 on press, Haptics Light on every interaction, 8pt grid, no blur shadows (no shadowRadius blend), nested depth (extruded card contains inset icon slot) Minimal hardware controls, smart home apps, aesthetic utility tools, health monitors, brand showcase pages",
    "tokens": "backgroundColor: '#E0E5EC', textPrimary: '#3D4852', textMuted: '#6B7280', accent: '#6C63FF', shadowLight: 'rgba(255,255,255,0.6)', shadowDark: 'rgba(163,177,198,0.7)', insetBg: '#D1D9E6', radiusCard: 32, radiusButton: 16, radiusPill: 999, shadowOffset: 6, shadowRadius: 10",
    "avoid": "High-density data, bright multi-color apps, apps needing strong visual hierarchy via color, dark-mode-only products",
    "bestFor": "Minimal hardware controls, smart home apps, aesthetic utility tools, health monitors, brand showcase pages",
    "performance": "✓ Lightweight",
    "accessibility": "⚠ Moderate (low-contrast risk)",
    "mobile": "✓ Mobile-First",
    "conversion": "✗ Low-Conversion"
  }
];

export const TYPEFACE_PROFILES: TypeProfile[] = [
  {
    "name": "Classic Elegant",
    "keywords": [
      "elegant",
      "luxury",
      "sophisticated",
      "timeless",
      "premium",
      "editorial"
    ],
    "heading": "Playfair Display",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap",
    "notes": "High contrast between elegant heading and clean body. Perfect for luxury/premium."
  },
  {
    "name": "Modern Professional",
    "keywords": [
      "modern",
      "professional",
      "clean",
      "corporate",
      "friendly",
      "approachable"
    ],
    "heading": "Poppins",
    "body": "Open Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap",
    "notes": "Geometric Poppins for headings, humanist Open Sans for readability."
  },
  {
    "name": "Tech Startup",
    "keywords": [
      "tech",
      "startup",
      "modern",
      "innovative",
      "bold",
      "futuristic"
    ],
    "heading": "Space Grotesk",
    "body": "DM Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@400;500;600;700&display=swap",
    "notes": "Space Grotesk has unique character, DM Sans is highly readable."
  },
  {
    "name": "Editorial Classic",
    "keywords": [
      "editorial",
      "classic",
      "literary",
      "traditional",
      "refined",
      "bookish"
    ],
    "heading": "Cormorant Garamond",
    "body": "Libre Baskerville",
    "importUrl": "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap",
    "notes": "All-serif pairing for traditional editorial feel."
  },
  {
    "name": "Minimal Swiss",
    "keywords": [
      "minimal",
      "clean",
      "swiss",
      "functional",
      "neutral",
      "professional"
    ],
    "heading": "Inter",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
    "notes": "Single font family with weight variations. Ultimate simplicity."
  },
  {
    "name": "Playful Creative",
    "keywords": [
      "playful",
      "friendly",
      "fun",
      "creative",
      "warm",
      "approachable"
    ],
    "heading": "Fredoka",
    "body": "Nunito",
    "importUrl": "https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap",
    "notes": "Rounded, friendly fonts perfect for playful UIs."
  },
  {
    "name": "Bold Statement",
    "keywords": [
      "bold",
      "impactful",
      "strong",
      "dramatic",
      "modern",
      "headlines"
    ],
    "heading": "Bebas Neue",
    "body": "Source Sans 3",
    "importUrl": "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Source+Sans+3:wght@300;400;500;600;700&display=swap",
    "notes": "Bebas Neue for large headlines only. All-caps display font."
  },
  {
    "name": "Wellness Calm",
    "keywords": [
      "calm",
      "wellness",
      "health",
      "relaxing",
      "natural",
      "organic"
    ],
    "heading": "Lora",
    "body": "Raleway",
    "importUrl": "https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&family=Raleway:wght@300;400;500;600;700&display=swap",
    "notes": "Lora's organic curves with Raleway's elegant simplicity."
  },
  {
    "name": "Developer Mono",
    "keywords": [
      "code",
      "developer",
      "technical",
      "precise",
      "functional",
      "hacker"
    ],
    "heading": "JetBrains Mono",
    "body": "IBM Plex Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap",
    "notes": "JetBrains for code, IBM Plex for UI. Developer-focused."
  },
  {
    "name": "Retro Vintage",
    "keywords": [
      "retro",
      "vintage",
      "nostalgic",
      "dramatic",
      "decorative",
      "bold"
    ],
    "heading": "Abril Fatface",
    "body": "Merriweather",
    "importUrl": "https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Merriweather:wght@300;400;700&display=swap",
    "notes": "Abril Fatface for hero headlines only. High-impact vintage feel."
  },
  {
    "name": "Geometric Modern",
    "keywords": [
      "geometric",
      "modern",
      "clean",
      "balanced",
      "contemporary",
      "versatile"
    ],
    "heading": "Outfit",
    "body": "Work Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Work+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Both geometric but Outfit more distinctive for headings."
  },
  {
    "name": "Luxury Serif",
    "keywords": [
      "luxury",
      "high-end",
      "fashion",
      "elegant",
      "refined",
      "premium"
    ],
    "heading": "Cormorant",
    "body": "Montserrat",
    "importUrl": "https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600;700&family=Montserrat:wght@300;400;500;600;700&display=swap",
    "notes": "Cormorant's elegance with Montserrat's geometric precision."
  },
  {
    "name": "Friendly SaaS",
    "keywords": [
      "friendly",
      "modern",
      "saas",
      "clean",
      "approachable",
      "professional"
    ],
    "heading": "Plus Jakarta Sans",
    "body": "Plus Jakarta Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Single versatile font. Modern alternative to Inter."
  },
  {
    "name": "News Editorial",
    "keywords": [
      "news",
      "editorial",
      "journalism",
      "trustworthy",
      "readable",
      "informative"
    ],
    "heading": "Newsreader",
    "body": "Roboto",
    "importUrl": "https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap",
    "notes": "Newsreader designed for long-form reading. Roboto for UI."
  },
  {
    "name": "Handwritten Charm",
    "keywords": [
      "handwritten",
      "personal",
      "friendly",
      "casual",
      "warm",
      "charming"
    ],
    "heading": "Caveat",
    "body": "Quicksand",
    "importUrl": "https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&family=Quicksand:wght@300;400;500;600;700&display=swap",
    "notes": "Use Caveat sparingly for accents. Quicksand for body."
  },
  {
    "name": "Corporate Trust",
    "keywords": [
      "corporate",
      "trustworthy",
      "accessible",
      "readable",
      "professional",
      "clean"
    ],
    "heading": "Lexend",
    "body": "Source Sans 3",
    "importUrl": "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=Source+Sans+3:wght@300;400;500;600;700&display=swap",
    "notes": "Lexend designed for readability. Excellent accessibility."
  },
  {
    "name": "Brutalist Raw",
    "keywords": [
      "brutalist",
      "raw",
      "technical",
      "monospace",
      "minimal",
      "stark"
    ],
    "heading": "Space Mono",
    "body": "Space Mono",
    "importUrl": "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap",
    "notes": "All-mono for raw brutalist aesthetic. Limited weights."
  },
  {
    "name": "Fashion Forward",
    "keywords": [
      "fashion",
      "avant-garde",
      "creative",
      "bold",
      "artistic",
      "edgy"
    ],
    "heading": "Syne",
    "body": "Manrope",
    "importUrl": "https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&family=Syne:wght@400;500;600;700&display=swap",
    "notes": "Syne's unique character for headlines. Manrope for readability."
  },
  {
    "name": "Soft Rounded",
    "keywords": [
      "soft",
      "rounded",
      "friendly",
      "approachable",
      "warm",
      "gentle"
    ],
    "heading": "Varela Round",
    "body": "Nunito Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;500;600;700&family=Varela+Round&display=swap",
    "notes": "Both rounded and friendly. Perfect for soft UI designs."
  },
  {
    "name": "Premium Sans",
    "keywords": [
      "premium",
      "modern",
      "clean",
      "sophisticated",
      "versatile",
      "balanced"
    ],
    "heading": "Satoshi",
    "body": "General Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap",
    "notes": "Note: Satoshi/General Sans on Fontshare. DM Sans as Google alternative."
  },
  {
    "name": "Vietnamese Friendly",
    "keywords": [
      "vietnamese",
      "international",
      "readable",
      "clean",
      "multilingual",
      "accessible"
    ],
    "heading": "Be Vietnam Pro",
    "body": "Noto Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700&family=Noto+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Be Vietnam Pro excellent Vietnamese support. Noto as fallback."
  },
  {
    "name": "Japanese Elegant",
    "keywords": [
      "japanese",
      "elegant",
      "traditional",
      "modern",
      "multilingual",
      "readable"
    ],
    "heading": "Noto Serif JP",
    "body": "Noto Sans JP",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@400;500;600;700&display=swap",
    "notes": "Noto fonts excellent Japanese support. Traditional + modern feel."
  },
  {
    "name": "Korean Modern",
    "keywords": [
      "korean",
      "modern",
      "clean",
      "professional",
      "multilingual",
      "readable"
    ],
    "heading": "Noto Sans KR",
    "body": "Noto Sans KR",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700&display=swap",
    "notes": "Clean Korean typography. Single font with weight variations."
  },
  {
    "name": "Chinese Traditional",
    "keywords": [
      "chinese",
      "traditional",
      "elegant",
      "cultural",
      "multilingual",
      "readable"
    ],
    "heading": "Noto Serif TC",
    "body": "Noto Sans TC",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=Noto+Serif+TC:wght@400;500;600;700&display=swap",
    "notes": "Traditional Chinese character support. Elegant pairing."
  },
  {
    "name": "Chinese Simplified",
    "keywords": [
      "chinese",
      "simplified",
      "modern",
      "professional",
      "multilingual",
      "readable"
    ],
    "heading": "Noto Sans SC",
    "body": "Noto Sans SC",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap",
    "notes": "Simplified Chinese support. Clean modern look."
  },
  {
    "name": "Arabic Elegant",
    "keywords": [
      "arabic",
      "elegant",
      "traditional",
      "cultural",
      "RTL",
      "readable"
    ],
    "heading": "Noto Naskh Arabic",
    "body": "Noto Sans Arabic",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@300;400;500;700&display=swap",
    "notes": "RTL support. Naskh for traditional, Sans for modern Arabic."
  },
  {
    "name": "Thai Modern",
    "keywords": [
      "thai",
      "modern",
      "readable",
      "clean",
      "multilingual",
      "accessible"
    ],
    "heading": "Noto Sans Thai",
    "body": "Noto Sans Thai",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@300;400;500;700&display=swap",
    "notes": "Clean Thai typography. Excellent readability."
  },
  {
    "name": "Hebrew Modern",
    "keywords": [
      "hebrew",
      "modern",
      "RTL",
      "clean",
      "professional",
      "readable"
    ],
    "heading": "Noto Sans Hebrew",
    "body": "Noto Sans Hebrew",
    "importUrl": "https://fonts.googleapis.com/css2?family=Noto+Sans+Hebrew:wght@300;400;500;700&display=swap",
    "notes": "RTL support. Clean modern Hebrew typography."
  },
  {
    "name": "Legal Professional",
    "keywords": [
      "legal",
      "professional",
      "traditional",
      "trustworthy",
      "formal",
      "authoritative"
    ],
    "heading": "EB Garamond",
    "body": "Lato",
    "importUrl": "https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600;700&family=Lato:wght@300;400;700&display=swap",
    "notes": "EB Garamond for authority. Lato for clean body text."
  },
  {
    "name": "Medical Clean",
    "keywords": [
      "medical",
      "clean",
      "accessible",
      "professional",
      "healthcare",
      "trustworthy"
    ],
    "heading": "Figtree",
    "body": "Noto Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700&family=Noto+Sans:wght@300;400;500;700&display=swap",
    "notes": "Clean, accessible fonts for medical contexts."
  },
  {
    "name": "Financial Trust",
    "keywords": [
      "financial",
      "trustworthy",
      "professional",
      "corporate",
      "banking",
      "serious"
    ],
    "heading": "IBM Plex Sans",
    "body": "IBM Plex Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "IBM Plex conveys trust and professionalism. Excellent for data."
  },
  {
    "name": "Real Estate Luxury",
    "keywords": [
      "real estate",
      "luxury",
      "elegant",
      "sophisticated",
      "property",
      "premium"
    ],
    "heading": "Cinzel",
    "body": "Josefin Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Josefin+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Cinzel's elegance for headlines. Josefin for modern body."
  },
  {
    "name": "Restaurant Menu",
    "keywords": [
      "restaurant",
      "menu",
      "culinary",
      "elegant",
      "foodie",
      "hospitality"
    ],
    "heading": "Playfair Display SC",
    "body": "Karla",
    "importUrl": "https://fonts.googleapis.com/css2?family=Karla:wght@300;400;500;600;700&family=Playfair+Display+SC:wght@400;700&display=swap",
    "notes": "Small caps Playfair for menu headers. Karla for descriptions."
  },
  {
    "name": "Art Deco",
    "keywords": [
      "art deco",
      "vintage",
      "1920s",
      "elegant",
      "decorative",
      "gatsby"
    ],
    "heading": "Poiret One",
    "body": "Didact Gothic",
    "importUrl": "https://fonts.googleapis.com/css2?family=Didact+Gothic&family=Poiret+One&display=swap",
    "notes": "Poiret One for art deco headlines only. Didact for body."
  },
  {
    "name": "Magazine Style",
    "keywords": [
      "magazine",
      "editorial",
      "publishing",
      "refined",
      "journalism",
      "print"
    ],
    "heading": "Libre Bodoni",
    "body": "Public Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Libre+Bodoni:wght@400;500;600;700&family=Public+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Bodoni's editorial elegance. Public Sans for clean UI."
  },
  {
    "name": "Crypto/Web3",
    "keywords": [
      "crypto",
      "web3",
      "futuristic",
      "tech",
      "blockchain",
      "digital"
    ],
    "heading": "Orbitron",
    "body": "Exo 2",
    "importUrl": "https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;500;600;700&family=Orbitron:wght@400;500;600;700&display=swap",
    "notes": "Orbitron for futuristic headers. Exo 2 for readable body."
  },
  {
    "name": "Gaming Bold",
    "keywords": [
      "gaming",
      "bold",
      "action",
      "esports",
      "competitive",
      "energetic"
    ],
    "heading": "Russo One",
    "body": "Chakra Petch",
    "importUrl": "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;500;600;700&family=Russo+One&display=swap",
    "notes": "Russo One for impact. Chakra Petch for techy body text."
  },
  {
    "name": "Indie/Craft",
    "keywords": [
      "indie",
      "craft",
      "handmade",
      "artisan",
      "organic",
      "creative"
    ],
    "heading": "Amatic SC",
    "body": "Cabin",
    "importUrl": "https://fonts.googleapis.com/css2?family=Amatic+SC:wght@400;700&family=Cabin:wght@400;500;600;700&display=swap",
    "notes": "Amatic for handwritten feel. Cabin for readable body."
  },
  {
    "name": "Startup Bold",
    "keywords": [
      "startup",
      "bold",
      "modern",
      "innovative",
      "confident",
      "dynamic"
    ],
    "heading": "Clash Display",
    "body": "Satoshi",
    "importUrl": "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Rubik:wght@300;400;500;600;700&display=swap",
    "notes": "Note: Clash Display on Fontshare. Outfit as Google alternative."
  },
  {
    "name": "E-commerce Clean",
    "keywords": [
      "ecommerce",
      "clean",
      "shopping",
      "product",
      "retail",
      "conversion"
    ],
    "heading": "Rubik",
    "body": "Nunito Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;500;600;700&family=Rubik:wght@300;400;500;600;700&display=swap",
    "notes": "Clean readable fonts perfect for product descriptions."
  },
  {
    "name": "Academic/Research",
    "keywords": [
      "academic",
      "research",
      "scholarly",
      "accessible",
      "readable",
      "educational"
    ],
    "heading": "Crimson Pro",
    "body": "Atkinson Hyperlegible",
    "importUrl": "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Crimson+Pro:wght@400;500;600;700&display=swap",
    "notes": "Crimson for scholarly headlines. Atkinson for accessibility."
  },
  {
    "name": "Dashboard Data",
    "keywords": [
      "dashboard",
      "data",
      "analytics",
      "code",
      "technical",
      "precise"
    ],
    "heading": "Fira Code",
    "body": "Fira Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap",
    "notes": "Fira family cohesion. Code for data, Sans for labels."
  },
  {
    "name": "Music/Entertainment",
    "keywords": [
      "music",
      "entertainment",
      "fun",
      "energetic",
      "bold",
      "performance"
    ],
    "heading": "Righteous",
    "body": "Poppins",
    "importUrl": "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Righteous&display=swap",
    "notes": "Righteous for bold entertainment headers. Poppins for body."
  },
  {
    "name": "Minimalist Portfolio",
    "keywords": [
      "minimal",
      "portfolio",
      "designer",
      "creative",
      "clean",
      "artistic"
    ],
    "heading": "Archivo",
    "body": "Space Grotesk",
    "importUrl": "https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
    "notes": "Space Grotesk for distinctive headers. Archivo for clean body."
  },
  {
    "name": "Kids/Education",
    "keywords": [
      "kids",
      "education",
      "playful",
      "friendly",
      "colorful",
      "learning"
    ],
    "heading": "Baloo 2",
    "body": "Comic Neue",
    "importUrl": "https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;500;600;700&family=Comic+Neue:wght@300;400;700&display=swap",
    "notes": "Fun, playful fonts for children. Comic Neue is readable comic style."
  },
  {
    "name": "Wedding/Romance",
    "keywords": [
      "wedding",
      "romance",
      "elegant",
      "script",
      "invitation",
      "feminine"
    ],
    "heading": "Great Vibes",
    "body": "Cormorant Infant",
    "importUrl": "https://fonts.googleapis.com/css2?family=Cormorant+Infant:wght@300;400;500;600;700&family=Great+Vibes&display=swap",
    "notes": "Great Vibes for elegant accents. Cormorant for readable text."
  },
  {
    "name": "Science/Tech",
    "keywords": [
      "science",
      "technology",
      "research",
      "data",
      "futuristic",
      "precise"
    ],
    "heading": "Exo",
    "body": "Roboto Mono",
    "importUrl": "https://fonts.googleapis.com/css2?family=Exo:wght@300;400;500;600;700&family=Roboto+Mono:wght@300;400;500;700&display=swap",
    "notes": "Exo for modern tech feel. Roboto Mono for code/data."
  },
  {
    "name": "Accessibility First",
    "keywords": [
      "accessible",
      "readable",
      "inclusive",
      "WCAG",
      "dyslexia-friendly",
      "clear"
    ],
    "heading": "Atkinson Hyperlegible",
    "body": "Atkinson Hyperlegible",
    "importUrl": "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap",
    "notes": "Designed for maximum legibility. Excellent for accessibility."
  },
  {
    "name": "Sports/Fitness",
    "keywords": [
      "sports",
      "fitness",
      "athletic",
      "energetic",
      "condensed",
      "action"
    ],
    "heading": "Barlow Condensed",
    "body": "Barlow",
    "importUrl": "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=Barlow:wght@300;400;500;600;700&display=swap",
    "notes": "Condensed for impact headlines. Regular Barlow for body."
  },
  {
    "name": "Luxury Minimalist",
    "keywords": [
      "luxury",
      "minimalist",
      "high-end",
      "sophisticated",
      "refined",
      "premium"
    ],
    "heading": "Bodoni Moda",
    "body": "Jost",
    "importUrl": "https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@400;500;600;700&family=Jost:wght@300;400;500;600;700&display=swap",
    "notes": "Bodoni's high contrast elegance. Jost for geometric body."
  },
  {
    "name": "Tech/HUD Mono",
    "keywords": [
      "tech",
      "futuristic",
      "hud",
      "sci-fi",
      "data",
      "monospaced",
      "precise"
    ],
    "heading": "Share Tech Mono",
    "body": "Fira Code",
    "importUrl": "https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap",
    "notes": "Share Tech Mono has that classic sci-fi look."
  },
  {
    "name": "Pixel Retro",
    "keywords": [
      "pixel",
      "retro",
      "gaming",
      "8-bit",
      "nostalgic",
      "arcade"
    ],
    "heading": "Press Start 2P",
    "body": "VT323",
    "importUrl": "https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap",
    "notes": "Press Start 2P is very wide/large. VT323 is better for body text."
  },
  {
    "name": "Neubrutalist Bold",
    "keywords": [
      "bold",
      "neubrutalist",
      "loud",
      "strong",
      "geometric",
      "quirky"
    ],
    "heading": "Lexend Mega",
    "body": "Public Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Lexend+Mega:wght@100..900&family=Public+Sans:wght@100..900&display=swap",
    "notes": "Lexend Mega has distinct character and variable weight."
  },
  {
    "name": "Academic/Archival",
    "keywords": [
      "academic",
      "old-school",
      "university",
      "research",
      "serious",
      "traditional"
    ],
    "heading": "EB Garamond",
    "body": "Crimson Text",
    "importUrl": "https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600;700&family=EB+Garamond:wght@400;500;600;700;800&display=swap",
    "notes": "Classic academic aesthetic. Very legible."
  },
  {
    "name": "Spatial Clear",
    "keywords": [
      "spatial",
      "legible",
      "glass",
      "system",
      "clean",
      "neutral"
    ],
    "heading": "Inter",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap",
    "notes": "Optimized for readability on dynamic backgrounds."
  },
  {
    "name": "Kinetic Motion",
    "keywords": [
      "kinetic",
      "motion",
      "futuristic",
      "speed",
      "wide",
      "tech"
    ],
    "heading": "Syncopate",
    "body": "Space Mono",
    "importUrl": "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syncopate:wght@400;700&display=swap",
    "notes": "Syncopate's wide stance works well with motion effects."
  },
  {
    "name": "Gen Z Brutal",
    "keywords": [
      "brutal",
      "loud",
      "shouty",
      "meme",
      "internet",
      "bold"
    ],
    "heading": "Anton",
    "body": "Epilogue",
    "importUrl": "https://fonts.googleapis.com/css2?family=Anton&family=Epilogue:wght@400;500;600;700&display=swap",
    "notes": "Anton is impactful and condensed. Good for stickers/badges."
  },
  {
    "name": "Bauhaus Geometric",
    "keywords": [
      "bauhaus",
      "geometric",
      "constructivist",
      "bold",
      "uppercase",
      "architectural",
      "mechanical",
      "poster",
      "tactile"
    ],
    "heading": "Outfit",
    "body": "Outfit",
    "importUrl": "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;900&display=swap",
    "notes": "Single-family system: Outfit 900 uppercase tracking-tighter for heroes; Outfit 700 uppercase for buttons/nav; Outfit 500 for body. Scale aggressively: text-4xl–text-5xl headlines on mobile."
  },
  {
    "name": "Minimalist Monochrome Editorial",
    "keywords": [
      "monochrome",
      "editorial",
      "austere",
      "typographic",
      "pocket manifesto",
      "luxury",
      "high contrast",
      "brutalist mobile"
    ],
    "heading": "Playfair Display",
    "body": "Source Serif 4",
    "importUrl": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400|Source+Serif+4:ital,wght@0,300;0,400;0,600;1,300",
    "notes": "Triple stack: Playfair Display 900 tracking-tighter leading-[0.9] for heroes (text-5xl–text-6xl breaks words graphically). Source Serif 4 300–600 for body legibility. JetBrains Mono 400–500 uppercase tracking-widest for tags/dates/labels. NO UI sans-serif — 100% serif/mono."
  },
  {
    "name": "Modern Dark Cinema (Inter System)",
    "keywords": [
      "dark",
      "cinematic",
      "technical",
      "precision",
      "clean",
      "premium",
      "developer",
      "professional",
      "high-end utility"
    ],
    "heading": "Inter",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
    "notes": "Single-family precision system: Inter 700 (-1.5 tracking) for Display 48pt; Inter 600 (-0.5 tracking) for H1 32pt / H2 24pt; Inter 400 for body 16pt; Inter 500 uppercase +1.2 tracking for labels/mono. Gradient text via mask-view + react-native-linear-gradient (#FFFFFF → rgba(255,255,255,0.7)) on major headers."
  },
  {
    "name": "SaaS Mobile Boutique (Calistoga + Inter)",
    "keywords": [
      "saas",
      "boutique",
      "electric",
      "warm",
      "editorial",
      "bold",
      "premium",
      "fintech",
      "business",
      "dual font",
      "human warmth"
    ],
    "heading": "Calistoga",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Calistoga:ital@0;1&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
    "notes": "Tri-stack: Calistoga (adds human warmth) for heroes 36–42pt leading-1.1; Inter 400–600 for body/UI 16–18pt; JetBrains Mono 12pt uppercase tracking-[1.5] for data labels and section badges. Scale: Hero 36–42pt, Section H2 28–32pt, Body 16–18pt, Label 12pt. Avoid italic Calistoga except editorial callouts."
  },
  {
    "name": "Terminal CLI Monospace",
    "keywords": [
      "terminal",
      "cli",
      "hacker",
      "monospace",
      "matrix",
      "developer",
      "retro-future",
      "command line",
      "precision",
      "OLED"
    ],
    "heading": "JetBrains Mono",
    "body": "JetBrains Mono",
    "importUrl": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;1,400",
    "notes": "Single monospace system: use ONLY JetBrains Mono (or SpaceMono-Regular as system fallback). Strict sizes: 12pt / 14pt / 16pt only — no in-between. Weight: 400 normal (bold ruins mono character). Line height: 1.2x font size for information density. Letter spacing: normal (monospaced auto-spacing). All UI labels uppercase. ASCII borders and text-based progress bars."
  },
  {
    "name": "Kinetic Brutalism (Space Grotesk)",
    "keywords": [
      "kinetic",
      "brutalist",
      "aggressive",
      "uppercase",
      "oversized",
      "display",
      "motion",
      "street",
      "bold",
      "high-energy",
      "zine"
    ],
    "heading": "Space Grotesk",
    "body": "Space Grotesk",
    "importUrl": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
    "notes": "Dominant single-family system: Space Grotesk 700–900 for ALL display. Scale: Hero 60–120pt (windowWidth/375*size), Section 40–50pt, Card titles 28–32pt, Body 18–20pt, Labels 12pt. ALL display/buttons/nav: UPPERCASE, letterSpacing -1 (large) / +2 (labels), lineHeight 0.9–1.1x. Use Inter as fallback. Font scale must use PixelRatio helper for responsive sizing."
  },
  {
    "name": "Flat Design Mobile (System Bold)",
    "keywords": [
      "flat",
      "clean",
      "system",
      "bold",
      "geometric",
      "cross-platform",
      "icon",
      "poster",
      "minimal",
      "functional",
      "responsive"
    ],
    "heading": "Inter",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap",
    "notes": "System-first strategy: Inter as primary, falls back to system SF/Roboto on iOS/Android. Scale: Headlines fontWeight 800 letterSpacing -0.5; Subheadings fontWeight 600 fontSize 18; Body fontWeight 400 lineHeight 24; Labels fontWeight 700 uppercase letterSpacing 1. Thick weights carry all hierarchy since there are no shadows. Use aggressive size contrast (poster rule: body 16pt vs headline 40pt+). Avoid italic."
  },
  {
    "name": "Material You MD3 (Roboto System)",
    "keywords": [
      "material design 3",
      "md3",
      "android",
      "google",
      "tonal",
      "friendly",
      "rounded",
      "accessible",
      "adaptive"
    ],
    "heading": "Roboto",
    "body": "Roboto",
    "importUrl": "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,400",
    "notes": "MD3 type scale: Display Large 56px/400/64px. Headline Large 32px/500/40px. Title Large 22px/500/28px. Body Large 16px/400/24px. Label Medium 12px/500/16px. Buttons and Labels: letterSpacing 0.1px. Use system Roboto on Android; load from Google Fonts for iOS parity. Never use custom weights beyond 300–700."
  },
  {
    "name": "Neo Brutalism Mobile (Space Grotesk Heavy)",
    "keywords": [
      "neo brutalism",
      "pop art",
      "loud",
      "bold",
      "heavy",
      "stickers",
      "mechanical",
      "high contrast",
      "cream",
      "gen-z"
    ],
    "heading": "Space Grotesk",
    "body": "Space Grotesk",
    "importUrl": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap",
    "notes": "Strictly 700 (Bold) and 900 (Black/Heavy) ONLY — never Regular or Light. Display: 48–64px. Heading: 24–32px. Body: 18–20px (stays heavy for brutalist density). Labels: 14px ALL CAPS letterSpacing 2. All buttons and navigation: uppercase. System bold as fallback. No italic, no thin weights."
  },
  {
    "name": "Bold Typography Mobile (Inter-Tight Poster)",
    "keywords": [
      "bold typography",
      "editorial",
      "poster",
      "near-black",
      "vermillion",
      "luxury",
      "type-as-hero",
      "manifesto",
      "high-contrast"
    ],
    "heading": "Inter",
    "body": "Playfair Display",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400|JetBrains+Mono:wght@400|Playfair+Display:ital@1",
    "notes": "Tri-stack: Inter 600–800 for all UI (letterSpacing -1.5px heroes, -0.5px subheads). Playfair Display Italic ONLY for pull quotes. JetBrains Mono for labels and stats. Scale: 12px labels, 16px body, 22px sub, 32px section, 40px H2, 56px H1, 72px Hero Statement. 5:1 ratio H1:Body is mandatory. lineHeight 1.1 headlines, 1.6 body. Underlines (2–3pt accent) replace buttons for interactions."
  },
  {
    "name": "Academia Mobile (Cormorant + Crimson + Cinzel)",
    "keywords": [
      "academia",
      "library",
      "mahogany",
      "parchment",
      "brass",
      "scholarly",
      "prestige",
      "antique",
      "victorian",
      "leather"
    ],
    "heading": "Cormorant Garamond",
    "body": "Crimson Pro",
    "importUrl": "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600&family=Cormorant+Garamond:ital,wght@0,300;0,500;0,700;1,300;1,500|Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400",
    "notes": "Triple-stack: Cormorant Garamond Medium for all headings (32–40px tight leading). Crimson Pro Regular for body reading text (16–18px, lineHeight 24–26px). Cinzel SemiBold for ALL-CAPS labels, overlines, section prefixes (10–12px, letterSpacing 2–3px). Drop caps: first letter 60px Cinzel in Brass #C9A962. Section prefix: VOLUME I/II/III in Cinzel 10px. NO sans-serif anywhere."
  },
  {
    "name": "Cyberpunk Mobile (Orbitron + JetBrains Mono)",
    "keywords": [
      "cyberpunk",
      "neon",
      "glitch",
      "hud",
      "sci-fi",
      "dark",
      "matrix green",
      "magenta",
      "chamfered",
      "tactical"
    ],
    "heading": "Orbitron",
    "body": "JetBrains Mono",
    "importUrl": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@700;900&display=swap",
    "notes": "Dual-stack: Orbitron 700–900 for H1 (42px uppercase letterSpacing 4, fontWeight 900). JetBrains Mono 400–500 for all body/data text (14px letterSpacing 1). Labels: 10px uppercase opacity 0.7. Heading scale aggressive: H1 42px, H2 28px, Section 20px. Body 14px monospace only. NO mixed sans-serif. Fallback: monospace system font. Orbitron requires loading — use NativeWind or useFonts hook."
  },
  {
    "name": "Web3 Bitcoin DeFi (Space Grotesk + Inter + Mono)",
    "keywords": [
      "web3",
      "bitcoin",
      "defi",
      "digital gold",
      "fintech",
      "crypto",
      "trustless",
      "luminescent",
      "precision",
      "dark"
    ],
    "heading": "Space Grotesk",
    "body": "Inter",
    "importUrl": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap",
    "notes": "Tri-stack: Space Grotesk 600–700 for headings (geometric, technical character). Inter 400–600 for all body and UI text (high legibility). JetBrains Mono Medium for all data/stats/prices/hashes (technical accuracy). Buttons: Inter Bold uppercase letterSpacing 1.5. Balance figures use MaskedView gradient text (orange→gold). Heading scale: H1 36–42px, H2 24–28px, body 16–18px, mono labels 12–14px."
  },
  {
    "name": "Claymorphism Mobile (Nunito + DM Sans)",
    "keywords": [
      "claymorphism",
      "clay",
      "rounded",
      "playful",
      "candy",
      "bubbly",
      "soft",
      "3d",
      "children",
      "education",
      "tactile",
      "spring",
      "nunito",
      "dm sans"
    ],
    "heading": "Nunito",
    "body": "DM Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400|Nunito:ital,wght@0,700;0,800;0,900;1,700",
    "notes": "Dual-stack: Nunito Black (900) or ExtraBold (800) for ALL headings — rounded terminals are mandatory. DM Sans Medium (500) for body text — clean and geometric. Scale: Hero 48px lineHeight 52 letterSpacing -1. Section Title 32px lineHeight 38. Card Title 22px lineHeight 28. Body 16px lineHeight 24. Never use Nunito for body text (too decorative at small sizes). Never use weights below 700 for any heading. includeFontPadding: false on all Nunito Text components for vertical centering in rounded buttons."
  },
  {
    "name": "Enterprise SaaS Mobile (Plus Jakarta Sans)",
    "keywords": [
      "enterprise",
      "saas",
      "b2b",
      "professional",
      "indigo",
      "modern",
      "approachable",
      "legible",
      "ios dynamic type",
      "android scaling"
    ],
    "heading": "Plus Jakarta Sans",
    "body": "Plus Jakarta Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400",
    "notes": "Single-family system: Plus Jakarta Sans balances professional authority with mobile approachability. Weight scale: ExtraBold 800 for screen titles/hero (line height 1.1–1.2). Bold 700 for section headers. SemiBold 600 for card titles and buttons. Regular 400 for body text (line height 1.4–1.5). Must support iOS Dynamic Type and Android font scaling — never hardcode pixel sizes without respecting system font scale. Button text: uppercase, letterSpacing 0.5. Caption: 12px Regular. Muted: Slate 500 #64748B."
  },
  {
    "name": "Sketch Hand-Drawn Mobile (Kalam + Patrick Hand)",
    "keywords": [
      "sketch",
      "hand-drawn",
      "handwriting",
      "human",
      "imperfect",
      "organic",
      "paper",
      "kalam",
      "patrick hand",
      "education",
      "journal",
      "creative"
    ],
    "heading": "Kalam",
    "body": "Patrick Hand",
    "importUrl": "https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Patrick+Hand&display=swap",
    "notes": "Dual handwritten stack: Kalam Bold (700) for all headings — high visual weight, felt-tip marker aesthetic, conveys intentional messiness. Patrick Hand Regular for all body text — highly legible at mobile sizes while remaining distinctly human. Scale: Heading 28–36px with lineHeight adjusted for descenders. Body 16–18px lineHeight 1.5. Labels 14px. Vary font sizes slightly between adjacent elements for spontaneous feel. Avoid alignment: 'center' for long body text — left-aligned reads more naturally. Both fonts require useFonts loading in Expo. Never use these fonts for financial figures or legal text."
  },
  {
    "name": "Neumorphism Mobile (Plus Jakarta Sans + System)",
    "keywords": [
      "neumorphism",
      "soft ui",
      "monochromatic",
      "cool grey",
      "minimal",
      "physical",
      "depth",
      "ceramic",
      "system font",
      "utility"
    ],
    "heading": "Plus Jakarta Sans",
    "body": "Plus Jakarta Sans",
    "importUrl": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,700;1,400",
    "notes": "Single-family or System fallback: Plus Jakarta Sans Bold/Medium pairs beautifully with the monochromatic #E0E5EC surface — subtle geometry without competing with the depth effect. Heading: 24–32px Bold (700), letterSpacing -0.5 for modern premium feel. Body: 16px Medium (500), lineHeight 1.4. Caption: 12px Regular (400). Use Text Primary #3D4852 (7.5:1 contrast against #E0E5EC) for all primary text. Use Text Muted #6B7280 (4.6:1 contrast) for secondary text. Accent color #6C63FF only on active labels or focus indicators. Never use italic or thin weights — they lose legibility against the embossed background. System (SF Pro / Roboto) is an acceptable fallback for performance-sensitive implementations."
  }
];

export const LANDING_PROFILES: LandingProfile[] = [
  {
    "name": "Hero + Features + CTA",
    "keywords": [
      "hero",
      "hero-centric",
      "hero-centric design",
      "features",
      "feature-rich",
      "feature-rich showcase",
      "cta",
      "call-to-action"
    ],
    "sections": "1. Hero with headline/image, 2. Value prop, 3. Key features (3-5), 4. CTA section, 5. Footer",
    "cta": "Hero (sticky) + Bottom"
  },
  {
    "name": "Hero + Testimonials + CTA",
    "keywords": [
      "hero",
      "testimonials",
      "social-proof",
      "social-proof-focused",
      "social proof focused",
      "trust",
      "reviews",
      "cta"
    ],
    "sections": "1. Hero, 2. Problem statement, 3. Solution overview, 4. Testimonials carousel, 5. CTA",
    "cta": "Hero (sticky) + Post-testimonials"
  },
  {
    "name": "Product Demo + Features",
    "keywords": [
      "demo",
      "product-demo",
      "features",
      "showcase",
      "interactive",
      "interactive-product-demo",
      "interactive product demo"
    ],
    "sections": "1. Hero, 2. Product video/mockup (center), 3. Feature breakdown per section, 4. Comparison (optional), 5. CTA",
    "cta": "Video center + CTA right/bottom"
  },
  {
    "name": "Minimal Single Column",
    "keywords": [
      "minimal",
      "simple",
      "direct",
      "minimal & direct",
      "minimal-direct",
      "single-column",
      "clean"
    ],
    "sections": "1. Hero headline, 2. Short description, 3. Benefit bullets (3 max), 4. CTA, 5. Footer",
    "cta": "Center, large CTA button"
  },
  {
    "name": "Funnel (3-Step Conversion)",
    "keywords": [
      "funnel",
      "conversion",
      "conversion-optimized",
      "conversion optimized",
      "steps",
      "wizard",
      "onboarding"
    ],
    "sections": "1. Hero, 2. Step 1 (problem), 3. Step 2 (solution), 4. Step 3 (action), 5. CTA progression",
    "cta": "Each step: mini-CTA. Final: main CTA"
  },
  {
    "name": "Comparison Table + CTA",
    "keywords": [
      "comparison",
      "table",
      "compare",
      "versus",
      "cta"
    ],
    "sections": "1. Hero, 2. Problem intro, 3. Comparison table (product vs competitors), 4. Pricing (optional), 5. CTA",
    "cta": "Table: Right column. CTA: Below table"
  },
  {
    "name": "Lead Magnet + Form",
    "keywords": [
      "lead",
      "form",
      "signup",
      "capture",
      "email",
      "magnet"
    ],
    "sections": "1. Hero (benefit headline), 2. Lead magnet preview (ebook cover, checklist, etc), 3. Form (minimal fields), 4. CTA submit",
    "cta": "Form CTA: Submit button"
  },
  {
    "name": "Pricing Page + CTA",
    "keywords": [
      "pricing",
      "plans",
      "tiers",
      "comparison",
      "cta"
    ],
    "sections": "1. Hero (pricing headline), 2. Price comparison cards, 3. Feature comparison table, 4. FAQ section, 5. Final CTA",
    "cta": "Each card: CTA button. Sticky CTA in nav"
  },
  {
    "name": "Video-First Hero",
    "keywords": [
      "video",
      "hero",
      "media",
      "visual",
      "engaging"
    ],
    "sections": "1. Hero with video background, 2. Key features overlay, 3. Benefits section, 4. CTA",
    "cta": "Overlay on video (center/bottom) + Bottom section"
  },
  {
    "name": "Scroll-Triggered Storytelling",
    "keywords": [
      "storytelling",
      "scroll",
      "narrative",
      "story",
      "immersive"
    ],
    "sections": "1. Intro hook, 2. Chapter 1 (problem), 3. Chapter 2 (journey), 4. Chapter 3 (solution), 5. Climax CTA",
    "cta": "End of each chapter (mini) + Final climax CTA"
  },
  {
    "name": "AI Personalization Landing",
    "keywords": [
      "ai",
      "personalization",
      "smart",
      "recommendation",
      "dynamic"
    ],
    "sections": "1. Dynamic hero (personalized), 2. Relevant features, 3. Tailored testimonials, 4. Smart CTA",
    "cta": "Context-aware placement based on user segment"
  },
  {
    "name": "Waitlist/Coming Soon",
    "keywords": [
      "waitlist",
      "coming-soon",
      "launch",
      "early-access",
      "notify"
    ],
    "sections": "1. Hero with countdown, 2. Product teaser/preview, 3. Email capture form, 4. Social proof (waitlist count)",
    "cta": "Email form prominent (above fold) + Sticky form on scroll"
  },
  {
    "name": "Comparison Table Focus",
    "keywords": [
      "comparison",
      "table",
      "versus",
      "compare",
      "features"
    ],
    "sections": "1. Hero (problem statement), 2. Comparison matrix (you vs competitors), 3. Feature deep-dive, 4. Winner CTA",
    "cta": "After comparison table (highlighted row) + Bottom"
  },
  {
    "name": "Pricing-Focused Landing",
    "keywords": [
      "pricing",
      "price",
      "cost",
      "plans",
      "subscription"
    ],
    "sections": "1. Hero (value proposition), 2. Pricing cards (3 tiers), 3. Feature comparison, 4. FAQ, 5. Final CTA",
    "cta": "Each pricing card + Sticky CTA in nav + Bottom"
  },
  {
    "name": "App Store Style Landing",
    "keywords": [
      "app",
      "mobile",
      "download",
      "store",
      "install"
    ],
    "sections": "1. Hero with device mockup, 2. Screenshots carousel, 3. Features with icons, 4. Reviews/ratings, 5. Download CTAs",
    "cta": "Download buttons prominent (App Store + Play Store) throughout"
  },
  {
    "name": "FAQ/Documentation Landing",
    "keywords": [
      "faq",
      "documentation",
      "help",
      "support",
      "questions",
      "faq/documentation",
      "knowledge base"
    ],
    "sections": "1. Hero with search bar, 2. Popular categories, 3. FAQ accordion, 4. Contact/support CTA",
    "cta": "Search bar prominent + Contact CTA for unresolved questions"
  },
  {
    "name": "Immersive/Interactive Experience",
    "keywords": [
      "immersive",
      "interactive",
      "experience",
      "3d",
      "animation",
      "immersive/interactive experience"
    ],
    "sections": "1. Full-screen interactive element, 2. Guided product tour, 3. Key benefits revealed, 4. CTA after completion",
    "cta": "After interaction complete + Skip option for impatient users"
  },
  {
    "name": "Event/Conference Landing",
    "keywords": [
      "event",
      "conference",
      "meetup",
      "registration",
      "schedule",
      "hero-centric design",
      "hero-centric"
    ],
    "sections": "1. Hero (date/location/countdown), 2. Speakers grid, 3. Agenda/schedule, 4. Sponsors, 5. Register CTA",
    "cta": "Register CTA sticky + After speakers + Bottom"
  },
  {
    "name": "Product Review/Ratings Focused",
    "keywords": [
      "reviews",
      "ratings",
      "testimonials",
      "social-proof",
      "social-proof-focused",
      "stars"
    ],
    "sections": "1. Hero (product + aggregate rating), 2. Rating breakdown, 3. Individual reviews, 4. Buy/CTA",
    "cta": "After reviews summary + Buy button alongside reviews"
  },
  {
    "name": "Community/Forum Landing",
    "keywords": [
      "community",
      "forum",
      "social",
      "members",
      "discussion"
    ],
    "sections": "1. Hero (community value prop), 2. Popular topics/categories, 3. Active members showcase, 4. Join CTA",
    "cta": "Join button prominent + After member showcase"
  },
  {
    "name": "Before-After Transformation",
    "keywords": [
      "before-after",
      "transformation",
      "results",
      "comparison"
    ],
    "sections": "1. Hero (problem state), 2. Transformation slider/comparison, 3. How it works, 4. Results CTA",
    "cta": "After transformation reveal + Bottom"
  },
  {
    "name": "Marketplace / Directory",
    "keywords": [
      "marketplace",
      "directory",
      "search",
      "listing"
    ],
    "sections": "1. Hero (Search focused), 2. Categories, 3. Featured Listings, 4. Trust/Safety, 5. CTA (Become a host/seller)",
    "cta": "Hero Search Bar + Navbar 'List your item'"
  },
  {
    "name": "Newsletter / Content First",
    "keywords": [
      "newsletter",
      "content",
      "writer",
      "blog",
      "subscribe",
      "minimal & direct",
      "minimal-direct"
    ],
    "sections": "1. Hero (Value Prop + Form), 2. Recent Issues/Archives, 3. Social Proof (Subscriber count), 4. About Author",
    "cta": "Hero inline form + Sticky header form"
  },
  {
    "name": "Webinar Registration",
    "keywords": [
      "webinar",
      "registration",
      "event",
      "training",
      "live"
    ],
    "sections": "1. Hero (Topic + Timer + Form), 2. What you'll learn, 3. Speaker Bio, 4. Urgency/Bonuses, 5. Form (again)",
    "cta": "Hero (Right side form) + Bottom anchor"
  },
  {
    "name": "Enterprise Gateway",
    "keywords": [
      "enterprise",
      "corporate",
      "gateway",
      "solutions",
      "portal",
      "trust",
      "authority",
      "trust & authority"
    ],
    "sections": "1. Hero (Video/Mission), 2. Solutions by Industry, 3. Solutions by Role, 4. Client Logos, 5. Contact Sales",
    "cta": "Contact Sales (Primary) + Login (Secondary)"
  },
  {
    "name": "Portfolio Grid",
    "keywords": [
      "portfolio",
      "grid",
      "showcase",
      "gallery",
      "masonry",
      "portfolio grid + visuals"
    ],
    "sections": "1. Hero (Name/Role), 2. Project Grid (Masonry), 3. About/Philosophy, 4. Contact",
    "cta": "Project Card Hover + Footer Contact"
  },
  {
    "name": "Horizontal Scroll Journey",
    "keywords": [
      "horizontal",
      "scroll",
      "journey",
      "gallery",
      "storytelling",
      "panoramic",
      "storytelling-driven"
    ],
    "sections": "1. Intro (Vertical), 2. The Journey (Horizontal Track), 3. Detail Reveal, 4. Vertical Footer",
    "cta": "Floating Sticky CTA or End of Horizontal Track"
  },
  {
    "name": "Bento Grid Showcase",
    "keywords": [
      "bento",
      "grid",
      "features",
      "modular",
      "apple-style",
      "showcase",
      "feature-rich showcase"
    ],
    "sections": "1. Hero, 2. Bento Grid (Key Features), 3. Detail Cards, 4. Tech Specs, 5. CTA",
    "cta": "Floating Action Button or Bottom of Grid"
  },
  {
    "name": "Interactive 3D Configurator",
    "keywords": [
      "3d",
      "configurator",
      "customizer",
      "interactive",
      "product",
      "interactive product demo"
    ],
    "sections": "1. Hero (Configurator), 2. Feature Highlight (synced), 3. Price/Specs, 4. Purchase",
    "cta": "Inside Configurator UI + Sticky Bottom Bar"
  },
  {
    "name": "AI-Driven Dynamic Landing",
    "keywords": [
      "ai",
      "dynamic",
      "personalized",
      "adaptive",
      "generative"
    ],
    "sections": "1. Prompt/Input Hero, 2. Generated Result Preview, 3. How it Works, 4. Value Prop",
    "cta": "Input Field (Hero) + 'Try it' Buttons"
  },
  {
    "name": "Feature-Rich Showcase",
    "keywords": [
      "feature-rich",
      "feature-rich showcase",
      "features",
      "showcase",
      "product showcase"
    ],
    "sections": "1. Hero (value prop), 2. Feature grid/cards (4-6), 3. Use cases or benefits, 4. Social proof or logos, 5. CTA",
    "cta": "Hero (sticky) + After features + Bottom"
  },
  {
    "name": "Hero-Centric Design",
    "keywords": [
      "hero-centric",
      "hero-centric design",
      "hero-first",
      "hero above fold"
    ],
    "sections": "1. Full-bleed Hero (headline + visual), 2. Single value prop strip, 3. Key benefit or proof, 4. Primary CTA",
    "cta": "Hero dominant (center/bottom) + Sticky nav CTA"
  },
  {
    "name": "Trust & Authority + Conversion",
    "keywords": [
      "trust & authority",
      "trust",
      "authority",
      "conversion",
      "credibility",
      "enterprise"
    ],
    "sections": "1. Hero (mission/credibility), 2. Proof (logos, certs, stats), 3. Solution overview, 4. Clear CTA path",
    "cta": "Contact Sales / Get Quote (primary) + Nav"
  },
  {
    "name": "Real-Time / Operations Landing",
    "keywords": [
      "real-time",
      "real-time monitor",
      "operations",
      "dashboard",
      "telemetry",
      "live data"
    ],
    "sections": "1. Hero (product + live preview or status), 2. Key metrics/indicators, 3. How it works, 4. CTA (Start trial / Contact)",
    "cta": "Primary CTA in nav + After metrics"
  }
];
