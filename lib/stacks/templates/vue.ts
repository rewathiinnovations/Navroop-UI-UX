import { VITE_SERVER_BLOCK, type ScaffoldFile } from './shared';

/**
 * Vue 3 + Vite only.
 * TODO(nuxt): Nuxt SSR scaffold is a separate follow-up. Do not implement Nuxt here.
 */
export function vueScaffold(devCommand: string): ScaffoldFile[] {
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
            vue: '^3.4.0',
          },
          devDependencies: {
            '@vitejs/plugin-vue': '^5.1.0',
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
      path: 'vite.config.js',
      content: `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
${VITE_SERVER_BLOCK}
})
`,
    },
    {
      path: 'tailwind.config.js',
      content: `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts}',
  ],
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
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.js',
      content: `import { createApp } from 'vue'
import App from './App.vue'
import './index.css'

createApp(App).mount('#app')
`,
    },
    {
      path: 'src/App.vue',
      content: `<script setup>
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
    <p class="text-lg text-gray-400">Sandbox ready. Vue 3 + Vite — edit src/App.vue.</p>
  </div>
</template>
`,
    },
    {
      path: 'src/index.css',
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}
`,
    },
  ];
}
