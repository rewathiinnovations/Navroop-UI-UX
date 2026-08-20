/**
 * Output-stack registry. All dev/install/extension lookups go through
 * getStack() — do not scatter stack conditionals.
 *
 * REACT values are copied from the upstream Open Lovable Vite React setup
 * (package.json scripts.dev = "vite --host", npm install, .jsx files).
 */

export const STACK_IDS = ['NEXTJS', 'REACT', 'STATIC_HTML'] as const;

export type StackId = (typeof STACK_IDS)[number];

/**
 * Legacy sandbox-image ids kept on the stack rows. The sandbox VM subsystem is
 * gone (migration 20260819010000_drop_sandbox_columns); nothing boots these.
 */
export type SandboxTemplate = {
  /** E2B template id. Default of @e2b/code-interpreter (generic Node). */
  e2b: string;
  /** Legacy node runtime id kept on the stack row. */
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
  /** Production build used by publish + the code-quality audit. Null when there is no bundler. */
  buildCommand: string | null;
  /** Static output directory for Coolify. Null for node deploys. */
  outputDir: string | null;
  deployType: 'static' | 'node';
  /** Node start command. Null for static. */
  startCommand: string | null;
  /** Optional Dockerfile override. Null = Nixpacks / static pack. */
  dockerfile: string | null;
  port: number | null;
  /** Compact PromptHero hint. Omit when neither SPA nor SSR applies. */
  seoHint?: string;
  /** Viewing a result uses a static snapshot when this is true. */
  canStaticPreview: boolean;
  /** Command run inside the generation sandbox before it is killed. Null = copy output dir. */
  previewBuildCommand: string | null;
  /** Directory uploaded as the static preview. */
  previewOutputDir: string;
  /** Extensionless routes serve entryPath (index.html). */
  spaFallback: boolean;
};

const STACKS: Record<StackId, StackDefinition> = {
  NEXTJS: {
    id: 'NEXTJS',
    label: 'Next.js (App Router)',
    hasNodeDependencies: true,
    // Plain `next dev` — the exported README prints this as the user's local
    // dev step; there is no sandbox preview port to bind any more.
    devCommand: 'next dev',
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
    buildCommand: 'npm run build',
    outputDir: null,
    deployType: 'node',
    startCommand: 'npm start',
    dockerfile: null,
    port: 3000,
    seoHint: 'SSR — best for SEO',
    // Preview may export statically; Coolify publish stays a Node deploy.
    canStaticPreview: true,
    previewBuildCommand: 'npm run build',
    previewOutputDir: 'out',
    spaFallback: false,
  },
  REACT: {
    id: 'REACT',
    label: 'React (Vite)',
    hasNodeDependencies: true,
    // Exact upstream Open Lovable Vite/React dev script.
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
    buildCommand: 'npm run build',
    outputDir: 'dist',
    deployType: 'static',
    startCommand: null,
    dockerfile: null,
    port: null,
    seoHint: 'SPA — weaker SEO',
    canStaticPreview: true,
    previewBuildCommand: 'npm run build',
    previewOutputDir: 'dist',
    spaFallback: true,
  },
  STATIC_HTML: {
    id: 'STATIC_HTML',
    label: 'Static HTML',
    hasNodeDependencies: false,
    // No npm install; `serve` picks its own default port locally.
    devCommand: 'npx serve .',
    installCommand: null,
    fileExtension: '.html',
    sandboxTemplate: GENERIC_NODE_SANDBOX,
    configFiles: ['package.json', 'package-lock.json'],
    frameworkPackages: [],
    listExtensions: ['.html', '.css', '.js'],
    entryPoint: 'index.html',
    buildCommand: null,
    outputDir: '.',
    deployType: 'static',
    startCommand: null,
    dockerfile: null,
    port: null,
    canStaticPreview: true,
    previewBuildCommand: null,
    previewOutputDir: '.',
    spaFallback: false,
  },
};

export const DEFAULT_STACK: StackId = 'NEXTJS';

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
 * HTTP / legacy callers may omit stack. Only this helper defaults to NEXTJS.
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
  if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('@/')) {
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

/**
 * Files an INITIAL build must include for the stack's dev server to render it.
 * Scaffold-owned files (src/main.jsx, configs) are not required — only the
 * root component/page the prompts direct the model to write.
 */
function initialBuildEntryCandidates(stack: string): string[] {
  switch (getStack(stack).id) {
    case 'NEXTJS':
      return ['app/page.tsx', 'app/page.jsx'];
    case 'REACT':
      return ['src/App.jsx', 'src/App.tsx'];
    case 'STATIC_HTML':
      return ['index.html'];
    default: {
      const id: never = getStack(stack).id as never;
      throw new Error(`Missing initial-build entry candidates for "${id}"`);
    }
  }
}

/**
 * Why an initial build's file set cannot work on this stack, or null when it
 * can. A model that ignores the stack prompt (e.g. writing Next.js app/page.tsx
 * for a Vite project) used to settle SUCCEEDED and then kill the sandbox boot;
 * this is the guard that turns that into an actionable failure instead.
 */
export function stackShapeMismatch(stack: string, filePaths: string[]): string | null {
  const candidates = initialBuildEntryCandidates(stack);
  const normalized = filePaths.map((path) => path.replace(/^\.?\//, ''));
  if (normalized.some((path) => candidates.includes(path))) return null;
  const label = getStack(stack).label;
  const got = normalized.slice(0, 3).join(', ') || 'no files';
  return `The generated files don't match the ${label} project layout (expected ${candidates[0]}; got ${got}). The build was not applied — try again, or switch the AI model in admin settings.`;
}
