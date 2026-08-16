/**
 * Output-stack registry. All sandbox/dev/install/extension lookups go through
 * getStack() — do not scatter stack conditionals.
 *
 * REACT values are copied from the current E2B/Vercel Vite React setup
 * (package.json scripts.dev = "vite --host", npm install, .jsx files).
 *
 * Sandbox images: official per-stack E2B templates are not used. @e2b/code-interpreter
 * ships `code-interpreter-v1` (generic Node). Vercel Sandbox uses `node22`.
 * Every stack records that template so create-sandbox is not hardcoded.
 */

export const STACK_IDS = [
  'NEXTJS',
  'REACT',
  'ASTRO',
  'STATIC_HTML',
  'VUE',
  'SVELTE',
] as const;

export type StackId = (typeof STACK_IDS)[number];

/**
 * Official, already-used sandbox images. Do not invent unpaid E2B templates.
 * Several stacks share the same Node image on purpose — swapping images is fragile.
 */
export type SandboxTemplate = {
  /** E2B template id. Default of @e2b/code-interpreter (generic Node). */
  e2b: string;
  /** Vercel Sandbox runtime. */
  vercelRuntime: string;
};

export const GENERIC_NODE_SANDBOX: SandboxTemplate = {
  e2b: 'code-interpreter-v1',
  vercelRuntime: 'node22',
};

const NODE_LOCK_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'] as const;

export type StackDefinition = {
  id: StackId;
  label: string;
  hasNodeDependencies: boolean;
  /** Command started after setup (and after install when hasNodeDependencies). */
  devCommand: string;
  /** Project-level install. Null when the stack has no node_modules. */
  installCommand: string | null;
  fileExtension: string;
  sandboxTemplate: SandboxTemplate;
  /** Filenames the apply pipeline must not overwrite. */
  configFiles: string[];
  /** Packages already provided by the scaffold — skip reinstall. */
  frameworkPackages: string[];
  /** Extensions get-sandbox-files should list. */
  listExtensions: string[];
  /** Default entry file for the file manifest. */
  entryPoint: string;
};

const STACKS: Record<StackId, StackDefinition> = {
  NEXTJS: {
    id: 'NEXTJS',
    label: 'Next.js (App Router)',
    hasNodeDependencies: true,
    // Bind the sandbox preview port (E2B/Vercel map 5173).
    devCommand: 'next dev -p 5173 -H 0.0.0.0',
    installCommand: 'npm install',
    fileExtension: '.tsx',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: [
      ...NODE_LOCK_FILES,
      'next.config.js',
      'next.config.mjs',
      'next.config.ts',
      'tailwind.config.js',
      'tailwind.config.ts',
      'postcss.config.js',
      'postcss.config.mjs',
    ],
    frameworkPackages: ['react', 'react-dom', 'next'],
    listExtensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
    entryPoint: 'app/page.tsx',
  },
  REACT: {
    id: 'REACT',
    label: 'React (Vite)',
    hasNodeDependencies: true,
    // Exact current Open Lovable Vite/React values (E2B + Vercel providers).
    devCommand: 'vite --host',
    installCommand: 'npm install',
    fileExtension: '.jsx',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: [
      'tailwind.config.js',
      'vite.config.js',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'postcss.config.js',
    ],
    frameworkPackages: ['react', 'react-dom'],
    listExtensions: ['.jsx', '.js', '.tsx', '.ts', '.css', '.json'],
    entryPoint: 'src/main.jsx',
  },
  ASTRO: {
    id: 'ASTRO',
    label: 'Astro',
    hasNodeDependencies: true,
    devCommand: 'astro dev',
    installCommand: 'npm install',
    fileExtension: '.astro',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: [
      ...NODE_LOCK_FILES,
      'astro.config.mjs',
      'astro.config.ts',
      'astro.config.js',
      'tailwind.config.js',
      'tailwind.config.mjs',
    ],
    frameworkPackages: ['astro'],
    listExtensions: ['.astro', '.ts', '.js', '.css', '.json', '.md', '.mdx'],
    entryPoint: 'src/pages/index.astro',
  },
  STATIC_HTML: {
    id: 'STATIC_HTML',
    label: 'Static HTML',
    hasNodeDependencies: false,
    // Listen on the sandbox preview port. No npm install.
    devCommand: 'npx serve . -l 5173',
    installCommand: null,
    fileExtension: '.html',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: ['package.json', 'package-lock.json'],
    frameworkPackages: [],
    listExtensions: ['.html', '.css', '.js'],
    entryPoint: 'index.html',
  },
  VUE: {
    id: 'VUE',
    label: 'Vue 3 (Vite)',
    hasNodeDependencies: true,
    // TODO(nuxt): Vue 3 + Vite only — not Nuxt. Nuxt SSR is a separate follow-up.
    // Do not implement Nuxt here (no nuxt.config, no pages/ Nuxt conventions).
    devCommand: 'vite dev',
    installCommand: 'npm install',
    fileExtension: '.vue',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: [
      ...NODE_LOCK_FILES,
      'vite.config.js',
      'vite.config.ts',
      'tailwind.config.js',
      'postcss.config.js',
    ],
    frameworkPackages: ['vue'],
    listExtensions: ['.vue', '.ts', '.js', '.css', '.json'],
    entryPoint: 'src/main.js',
  },
  SVELTE: {
    id: 'SVELTE',
    label: 'SvelteKit (Vite)',
    hasNodeDependencies: true,
    // SvelteKit's Vite-based `vite dev` (not `svelte-kit dev`).
    devCommand: 'vite dev',
    installCommand: 'npm install',
    fileExtension: '.svelte',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: [
      ...NODE_LOCK_FILES,
      'vite.config.js',
      'vite.config.ts',
      'svelte.config.js',
      'tailwind.config.js',
      'postcss.config.js',
    ],
    frameworkPackages: ['svelte', '@sveltejs/kit'],
    listExtensions: ['.svelte', '.ts', '.js', '.css', '.json'],
    entryPoint: 'src/routes/+page.svelte',
  },
};

export const DEFAULT_STACK: StackId = 'REACT';

export function isStackId(value: unknown): value is StackId {
  return typeof value === 'string' && (STACK_IDS as readonly string[]).includes(value);
}

/**
 * Typed lookup. Throws if the id is missing or unknown.
 * Never silently falls through to REACT for a non-REACT stack.
 */
export function getStack(stack: string): StackDefinition {
  if (!isStackId(stack)) {
    throw new Error(`Unknown stack "${stack}". Expected one of: ${STACK_IDS.join(', ')}`);
  }
  const definition = STACKS[stack];
  if (!definition) {
    throw new Error(`Missing stack registry entry for "${stack}"`);
  }
  return definition;
}

/**
 * HTTP / legacy callers may omit stack. Only this helper defaults to REACT.
 * Invalid values still throw — never coerce a typo to React.
 */
export function resolveStackOrDefault(value: unknown): StackId {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_STACK;
  }
  return getStack(String(value)).id;
}

export function shouldInstallPackages(stack: string): boolean {
  const definition = getStack(stack);
  return definition.hasNodeDependencies && Boolean(definition.installCommand);
}

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function getSandboxTemplate(stack: string): SandboxTemplate {
  return getStack(stack).sandboxTemplate;
}

export function getStackConfigFiles(stack: string): string[] {
  return getStack(stack).configFiles;
}

export function isStackConfigFile(stack: string, filePath: string): boolean {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() || '';
  return getStack(stack).configFiles.includes(fileName);
}

/**
 * True when this import is relative, aliased, or a per-stack framework package
 * already provided by the scaffold. Never applies the React skip list to other stacks.
 */
export function shouldSkipPackageInstall(stack: string, importPath: string): boolean {
  if (
    importPath.startsWith('.') ||
    importPath.startsWith('/') ||
    importPath.startsWith('@/')
  ) {
    return true;
  }
  const packageName = importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0];
  return getStack(stack).frameworkPackages.includes(packageName);
}

export function packageNameFromImport(importPath: string): string {
  return importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0];
}

export function getStackListExtensions(stack: string): string[] {
  return getStack(stack).listExtensions;
}

export function getStackEntryPoint(stack: string): string {
  return getStack(stack).entryPoint;
}

/**
 * Only the REACT Vite app rewrites loose files into src/.
 * Other stacks keep their own roots (app/, src/pages/, src/routes/, *.html).
 */
export function shouldForceSrcPrefix(stack: string): boolean {
  return getStack(stack).id === 'REACT';
}
