import type { ScaffoldFile } from './shared';

export function astroScaffold(devCommand: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'sandbox-app',
          version: '1.0.0',
          type: 'module',
          scripts: {
            dev: devCommand,
            build: 'astro build',
            preview: 'astro preview',
          },
          dependencies: {
            astro: '^4.16.0',
          },
          devDependencies: {
            '@astrojs/tailwind': '^5.1.0',
            tailwindcss: '^3.3.0',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'astro.config.mjs',
      content: `import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [tailwind()],
  server: {
    host: true,
    port: 5173,
  },
});
`,
    },
    {
      path: 'tailwind.config.mjs',
      content: `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: { extend: {} },
  plugins: [],
};
`,
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            module: 'esnext',
            moduleResolution: 'bundler',
            target: 'esnext',
            jsx: 'preserve',
            isolatedModules: true,
            skipLibCheck: true,
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/pages/index.astro',
      content: `---
---
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox App</title>
  </head>
  <body class="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
    <p class="text-lg text-gray-400">Sandbox ready. Astro — edit src/pages/index.astro.</p>
  </body>
</html>
`,
    },
  ];
}
