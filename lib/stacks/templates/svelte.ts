import { VITE_SERVER_BLOCK, type ScaffoldFile } from './shared';

export function svelteScaffold(devCommand: string): ScaffoldFile[] {
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
            build: 'vite build',
            preview: 'vite preview',
          },
          dependencies: {
            '@sveltejs/adapter-auto': '^3.3.0',
            '@sveltejs/kit': '^2.8.0',
            svelte: '^5.1.0',
          },
          devDependencies: {
            '@sveltejs/vite-plugin-svelte': '^4.0.0',
            autoprefixer: '^10.4.16',
            postcss: '^8.4.31',
            tailwindcss: '^3.3.0',
            vite: '^5.4.0',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'svelte.config.js',
      content: `import adapter from '@sveltejs/adapter-auto';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: { adapter },
};

export default config;
`,
    },
    {
      path: 'vite.config.js',
      content: `import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit()],
${VITE_SERVER_BLOCK}
})
`,
    },
    {
      path: 'tailwind.config.js',
      content: `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: { extend: {} },
  plugins: [],
};
`,
    },
    {
      path: 'postcss.config.js',
      content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
    },
    {
      path: 'src/app.html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
    },
    {
      path: 'src/app.css',
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}
`,
    },
    {
      path: 'src/routes/+layout.svelte',
      content: `<script>
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
`,
    },
    {
      path: 'src/routes/+page.svelte',
      content: `<div class="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
  <p class="text-lg text-gray-400">Sandbox ready. SvelteKit — edit src/routes/+page.svelte.</p>
</div>
`,
    },
  ];
}
