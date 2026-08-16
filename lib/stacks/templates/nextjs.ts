import type { ScaffoldFile } from './shared';

export function nextjsScaffold(devCommand: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'sandbox-app',
          version: '1.0.0',
          private: true,
          scripts: {
            dev: devCommand,
            build: 'next build',
            start: 'next start',
          },
          dependencies: {
            next: '14.2.18',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@types/node': '^20.0.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
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
const nextConfig = {
  allowedDevOrigins: ['.e2b.app', '.e2b.dev', '.vercel.run', 'localhost'],
};

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
      path: 'tailwind.config.js',
      content: `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};
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
    {
      path: 'app/globals.css',
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}
`,
    },
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
    <main className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <p className="text-lg text-gray-400">
        Sandbox ready. Next.js App Router — edit app/page.tsx.
      </p>
    </main>
  );
}
`,
    },
  ];
}
