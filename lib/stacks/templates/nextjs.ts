import type { DirectionTokens } from '@/lib/design/directions';
import type { ScaffoldFile } from './shared';
import { NEXTJS_STARTER_LAYOUT, STARTER_DEPENDENCIES, starterKitFiles } from './starter-kit';

export function nextjsScaffold(devCommand: string, tokens: DirectionTokens): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'navroop-app',
          version: '1.0.0',
          private: true,
          scripts: {
            dev: devCommand,
            build: 'next build',
            start: 'next start',
          },
          // Same majors the generation prompts target (lib/stack-prompts/nextjs.ts
          // says "Next.js 16") and the in-browser preview runs (React 19 via
          // lib/preview/deps.ts). A Next 14 / React 18 pin here meant generated
          // React-19 code passed the in-process esbuild check and then failed
          // `next build` in the user's own repo.
          //
          // The starter-kit entries carry the same versions the preview import
          // map pins, for the same reason pointed the other way: a caret range
          // that drifts is how a preview and a deployed site become different
          // sites without anything reporting it.
          dependencies: {
            next: '^16.0.0',
            react: '^19.0.0',
            'react-dom': '^19.0.0',
            ...STARTER_DEPENDENCIES,
          },
          devDependencies: {
            '@types/node': '^20.0.0',
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            autoprefixer: '^10.4.16',
            postcss: '^8.4.31',
            tailwindcss: '^3.3.0',
            typescript: '^5.0.0',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'next.config.mjs',
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`,
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
          exclude: ['node_modules'],
        },
        null,
        2,
      ),
    },
    {
      path: 'next-env.d.ts',
      content: `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`,
    },
    {
      path: 'postcss.config.js',
      content: `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
    },
    // `app/globals.css` and `tailwind.config.js` come from the starter kit: the
    // stylesheet carries this direction's token block and the config maps the
    // semantic classes onto it. The old scaffold's bare `body { font-family }`
    // rule is deliberately gone — type comes from the direction prompt, and a
    // system-font rule in the scaffold silently overrode it.
    ...starterKitFiles(NEXTJS_STARTER_LAYOUT, tokens),
    {
      path: 'app/layout.tsx',
      content: `import './globals.css';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: 'app/page.tsx',
      content: `export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <p className="text-lg text-muted-foreground">
        Your new Next.js App Router site — edit app/page.tsx.
      </p>
    </main>
  );
}
`,
    },
  ];
}
