import type { DirectionTokens } from '@/lib/design/directions';
import type { ScaffoldFile } from './shared';
import { REACT_STARTER_LAYOUT, STARTER_DEPENDENCIES, starterKitFiles } from './starter-kit';

/**
 * The Vite/React project scaffold.
 *
 * This used to live inside the sandbox providers' setupViteApp. With the
 * sandboxes gone it belongs here, because it is what makes an exported or
 * pushed React project an actual runnable repo rather than a folder of
 * components.
 */
export function reactScaffold(devCommand: string, tokens: DirectionTokens): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'navroop-app',
          version: '1.0.0',
          private: true,
          type: 'module',
          scripts: {
            dev: devCommand,
            build: 'vite build',
            preview: 'vite preview --host --port 3000',
          },
          dependencies: {
            react: '^19.0.0',
            'react-dom': '^19.0.0',
            ...STARTER_DEPENDENCIES,
          },
          devDependencies: {
            // tsconfig sets strict: true, so the React type packages are not
            // optional — without them the exported project cannot typecheck.
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.3.4',
            autoprefixer: '^10.4.16',
            postcss: '^8.4.31',
            tailwindcss: '^3.4.17',
            typescript: '^5.6.0',
            vite: '^6.0.0',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'vite.config.js',
      // The `@` alias is not optional now that the starter components import
      // `@/lib/utils`: the in-browser preview resolves `@/` itself, but a real
      // `vite build` in the exported repo has only this.
      content: `import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
`,
    },
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.tsx',
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    },
    // `src/index.css`, `tailwind.config.js`, `src/lib/utils.ts` and
    // `src/components/ui/*` all come from the starter kit, so NEXTJS and REACT
    // cannot drift apart on the token names or the primitives.
    ...starterKitFiles(REACT_STARTER_LAYOUT, tokens),
    {
      path: 'postcss.config.js',
      content: `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`,
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            // Without these the starter components' `@/lib/utils` import fails
            // `tsc` in the exported repo, even though Vite resolves it.
            baseUrl: '.',
            paths: { '@/*': ['./src/*'] },
          },
          include: ['src'],
        },
        null,
        2,
      ),
    },
  ];
}
