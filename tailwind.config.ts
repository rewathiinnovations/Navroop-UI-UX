import typography from '@tailwindcss/typography';
import gradientMaskImage from 'tailwind-gradient-mask-image';
import defaultTheme from 'tailwindcss/defaultTheme';
import type { Config, PluginAPI } from 'tailwindcss/types/config';

import colorsJson from './styles/colors.json';

const colors = Object.keys(colorsJson).reduce(
  (acc, key) => {
    acc[key] = `var(--${key})`;

    return acc;
  },
  {} as Record<string, string>,
);

const sizes = Array.from({ length: 1000 }, (_, i) => i).reduce(
  (acc, curr) => {
    acc[curr] = `${curr}px`;

    return acc;
  },
  {
    max: 'max-content',
    unset: 'unset',
    full: '100%',
    inherit: 'inherit',
    '1/2': '50%',
    '1/3': '33.3%',
    '2/3': '66.6%',
    '1/4': '25%',
    '1/6': '16.6%',
    '2/6': '33.3%',
    '3/6': '50%',
    '4/6': '66.6%',
    '5/6': '83.3%',
  } as Record<string, string>,
);

// The pixel-only subset of `sizes`, for utilities that arithmetically halve their value.
const lengthSizes = Object.fromEntries(
  Object.entries(sizes).filter(([, value]) => /^\d+px$/.test(value)),
) as Record<string, string>;

const opacities = Array.from({ length: 100 }, (_, i) => i).reduce(
  (acc, curr) => {
    acc[curr] = curr / 100 + '';

    return acc;
  },
  {} as Record<string, string>,
);

const transitionDurations = Array.from({ length: 60 }, (_, i) => i).reduce(
  (acc, curr) => {
    acc[curr] = curr * 50 + '';

    return acc;
  },
  {} as Record<string, string>,
);

const themeConfig: Config = {
  darkMode: 'class',
  content: ['./components/**/*.{js,ts,jsx,tsx,mdx}', './app/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'var(--font-inter)', ...defaultTheme.fontFamily.sans],
        mono: ['var(--font-geist-mono)', ...defaultTheme.fontFamily.mono],
        ascii: ['var(--font-roboto-mono)', ...defaultTheme.fontFamily.mono],
        wordmark: ['var(--font-wordmark)', ...defaultTheme.fontFamily.sans],
      },
      fontSize: {
        'title-h1': [
          '60px',
          {
            lineHeight: '64px',
            letterSpacing: '-0.3px',
            fontWeight: '500',
          },
        ],
        'title-h2': [
          '52px',
          {
            lineHeight: '56px',
            letterSpacing: '-0.52px',
            fontWeight: '500',
          },
        ],
        'title-h3': [
          '40px',
          {
            lineHeight: '44px',
            letterSpacing: '-0.4px',
            fontWeight: '500',
          },
        ],
        'title-h4': [
          '32px',
          {
            lineHeight: '36px',
            letterSpacing: '-0.32px',
            fontWeight: '500',
          },
        ],
        'title-h5': [
          '24px',
          {
            lineHeight: '32px',
            letterSpacing: '-0.24px',
            fontWeight: '500',
          },
        ],
        'body-x-large': [
          '20px',
          {
            lineHeight: '28px',
            letterSpacing: '-0.1px',
            fontWeight: '400',
          },
        ],
        'body-large': [
          '16px',
          {
            lineHeight: '24px',
            letterSpacing: '0px',
            fontWeight: '400',
          },
        ],
        'body-medium': [
          '14px',
          {
            lineHeight: '20px',
            letterSpacing: '0.14px',
            fontWeight: '400',
          },
        ],
        'body-small': [
          '13px',
          {
            lineHeight: '20px',
            letterSpacing: '0px',
            fontWeight: '400',
          },
        ],
        'body-input': [
          '15px',
          {
            lineHeight: '24px',
            letterSpacing: '0px',
            fontWeight: '400',
          },
        ],
        'label-x-large': [
          '20px',
          {
            lineHeight: '28px',
            letterSpacing: '-0.1px',
            fontWeight: '450',
          },
        ],
        'label-large': [
          '16px',
          {
            lineHeight: '24px',
            letterSpacing: '0px',
            fontWeight: '450',
          },
        ],
        'label-medium': [
          '14px',
          {
            lineHeight: '20px',
            letterSpacing: '0px',
            fontWeight: '450',
          },
        ],
        'label-small': [
          '13px',
          {
            lineHeight: '20px',
            letterSpacing: '0px',
            fontWeight: '450',
          },
        ],
        'label-x-small': [
          '12px',
          {
            lineHeight: '20px',
            letterSpacing: '0px',
            fontWeight: '450',
          },
        ],
        'mono-medium': [
          '14px',
          {
            lineHeight: '22px',
            letterSpacing: '0px',
            fontWeight: '400',
          },
        ],
        'mono-small': [
          '13px',
          {
            lineHeight: '20px',
            letterSpacing: '0px',
            fontWeight: '500',
          },
        ],
        'mono-x-small': [
          '12px',
          {
            lineHeight: '16px',
            letterSpacing: '0px',
            fontWeight: '400',
          },
        ],
        'title-blog': [
          '28px',
          {
            lineHeight: '36px',
            letterSpacing: '-0.28px',
            fontWeight: '500',
          },
        ],
      },
      colors: {
        transparent: 'transparent',
        current: 'currentColor',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        ...colors,
      },
      screens: {
        xs: { min: '390px' },
        'xs-max': { max: '389px' },
        sm: { min: '576px' },
        'sm-max': { max: '575px' },
        md: { min: '768px' },
        'md-max': { max: '767px' },
        lg: { min: '996px' },
        'lg-max': { max: '995px' },
        xl: { min: '1200px' },
        'xl-max': { max: '1199px' },
      },
      opacity: opacities,
      spacing: {
        ...sizes,
        root: 'var(--root-padding)',
      },
      width: sizes,
      maxWidth: sizes,
      height: sizes,
      inset: sizes,
      borderWidth: sizes,
      backdropBlur: Array.from({ length: 20 }, (_, i) => i).reduce(
        (acc, curr) => {
          acc[curr] = curr + 'px';

          return acc;
        },
        {} as Record<string, string>,
      ),
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.25, 0.1, 0.25, 1)' },
      transitionDuration: {
        DEFAULT: '200ms',
        ...transitionDurations,
      },
      transitionDelay: {
        ...transitionDurations,
      },
      borderRadius: (() => {
        const radius: Record<string | number, string> = {
          full: '999px',
          inherit: 'inherit',
          0: '0px',
          lg: 'var(--radius)',
          md: 'calc(var(--radius) - 2px)',
          sm: 'calc(var(--radius) - 4px)',
        };

        for (let i = 1; i <= 32; i += 1) {
          radius[i] = `${i}px`;
        }

        return radius;
      })(),
    },
  },
  plugins: [
    ({ addUtilities, matchUtilities }: PluginAPI) => {
      addUtilities({
        // Inside-border utilities are defined in inside-border-fix.css to avoid Tailwind variant conflicts
        '.mask-border': {
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          'mask-composite': 'exclude',
          'pointer-events': 'none',
        },
        '.center-x': { '@apply absolute left-1/2 -translate-x-1/2': {} },
        '.center-y': { '@apply absolute top-1/2 -translate-y-1/2': {} },
        '.center': { '@apply absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2': {} },
        '.flex-center': { '@apply flex items-center justify-center': {} },
        '.overlay': { '@apply absolute top-0 left-0 w-full h-full rounded-inherit': {} },
        '.text-gradient': { '@apply !bg-clip-text !text-transparent': {} },
      });
      matchUtilities(
        {
          cw: (value: string) => {
            const width = parseInt(value);

            return {
              width: value,
              left: `calc(50% - ${width / 2}px)`,
            };
          },
          ch: (value: string) => {
            const height = parseInt(value);

            return {
              height: value,
              top: `calc(50% - ${height / 2}px)`,
            };
          },
          cs: (value: string) => {
            const size = parseInt(value);

            return {
              width: value,
              height: value,
              left: `calc(50% - ${size / 2}px)`,
              top: `calc(50% - ${size / 2}px)`,
            };
          },
        },
        // These three centre by halving their own size, so they are only correct for a
        // pixel length. `sizes` also holds "max-content", "unset", "100%" and the n/6
        // fractions; `parseInt` on those yields NaN or reads "50%" as 50px, which emits a
        // broken `left: calc(50% - NaNpx)` beside a working `width` — an element that sizes
        // but does not centre. Restricting to the numeric keys plus `type: ['length']` makes
        // a non-length value produce no class at all instead.
        { values: lengthSizes, type: ['length'] },
      );
    },
    gradientMaskImage,
    typography,
  ],
};

export default themeConfig;
