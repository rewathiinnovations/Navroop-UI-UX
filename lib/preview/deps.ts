import { renderTailwindConfigExpression } from '@/lib/design/tailwind-theme';

/**
 * Runtime dependencies for the in-browser preview, resolved from esm.sh.
 *
 * Generated apps import these as bare specifiers; the bundler keeps them
 * external and the iframe's import map points each one at esm.sh. Versions are
 * pinned so a preview cannot change under the user between reloads, and the
 * pins must equal `STARTER_DEPENDENCIES` in
 * lib/stacks/templates/starter-kit.ts — two version sources that disagree is
 * how a preview and a deployed site quietly become different sites.
 *
 * The Radix and `class-variance-authority` entries are what the locked
 * shadcn/ui starter kit needs. Each was checked against esm.sh under the real
 * `?external=react,react-dom` form the import map builds: transitive Radix
 * internals come back as esm.sh's own absolute URLs, so top-level entries are
 * all the map needs.
 */
export const PREVIEW_DEPS: Record<string, string> = {
  react: '19.2.0',
  'react-dom': '19.2.0',
  'lucide-react': '0.548.0',
  clsx: '2.1.1',
  'tailwind-merge': '3.4.0',
  'class-variance-authority': '0.7.1',
  '@radix-ui/react-slot': '1.2.3',
  '@radix-ui/react-dialog': '1.1.15',
  '@radix-ui/react-label': '2.1.7',
  '@radix-ui/react-tabs': '1.1.13',
  'framer-motion': '12.23.24',
  recharts: '2.15.4',
  'date-fns': '4.1.0',
};

/**
 * The theme extension the preview frame's Play CDN is configured with.
 *
 * Static on purpose: the colours are `hsl(var(--x) / <alpha-value>)` and the
 * per-direction values arrive as CSS variables from the starter stylesheet,
 * which `findGlobalCss` already pulls into the bundle. Without this the frame
 * runs the CDN's stock theme, `bg-background` compiles to nothing, and every
 * generated site previews unstyled while the exported repo renders correctly.
 */
export const TAILWIND_PREVIEW_CONFIG: string = renderTailwindConfigExpression();

/** Tailwind Play CDN — compiles utility classes inside the iframe. */
export const TAILWIND_BROWSER_URL = 'https://cdn.tailwindcss.com';

export function buildImportMap(deps: Record<string, string> = PREVIEW_DEPS) {
  const imports: Record<string, string> = {
    react: `https://esm.sh/react@${deps.react}`,
    'react/jsx-runtime': `https://esm.sh/react@${deps.react}/jsx-runtime`,
    'react-dom': `https://esm.sh/react-dom@${deps['react-dom']}`,
    'react-dom/client': `https://esm.sh/react-dom@${deps['react-dom']}/client`,
  };

  for (const [name, version] of Object.entries(deps)) {
    if (name === 'react' || name === 'react-dom') continue;
    // external=react,react-dom keeps every package on the single React copy
    // above; without it esm.sh inlines its own and hooks break with the
    // "invalid hook call" error.
    imports[name] = `https://esm.sh/${name}@${version}?external=react,react-dom`;
    imports[`${name}/`] = `https://esm.sh/${name}@${version}/`;
  }

  return { imports };
}

/**
 * Packages a project may add on request, through `add_dependency`.
 *
 * Pinned for the same reason `PREVIEW_DEPS` is: a preview must not change under
 * the user between reloads. `add_dependency` may only choose from this set — an
 * open registry lookup would put an unreviewed package on the esm.sh import map
 * of every future reload of that project, which is a supply-chain decision no
 * model should be making.
 */
export const OPTIONAL_PREVIEW_DEPS: Record<string, string> = {
  zod: '3.25.76',
  'react-hook-form': '7.62.0',
  '@hookform/resolvers': '5.2.2',
  '@radix-ui/react-accordion': '1.2.12',
  '@radix-ui/react-checkbox': '1.3.3',
  '@radix-ui/react-dropdown-menu': '2.1.16',
  '@radix-ui/react-popover': '1.1.15',
  '@radix-ui/react-select': '2.2.6',
  '@radix-ui/react-separator': '1.1.7',
  '@radix-ui/react-switch': '1.2.5',
  '@radix-ui/react-tooltip': '1.2.8',
  'embla-carousel-react': '8.6.0',
};

/**
 * The import map for one project: the always-available set, plus whichever
 * optional packages its own `package.json` asks for.
 *
 * The version in the file is deliberately ignored — the pin is the product's, so
 * a model that writes `"zod": "^4"` still gets the reviewed build. A dependency
 * in neither map is ignored here and reported by `resolveBareSpecifier`, which is
 * the one place that decides whether an import resolves.
 */
export function projectPreviewDeps(files: Record<string, string>): Record<string, string> {
  const manifest = files['package.json'] ?? files['src/package.json'];
  if (!manifest) return PREVIEW_DEPS;
  let declared: unknown;
  try {
    declared = JSON.parse(manifest);
  } catch {
    // A malformed manifest is already refused at write time by
    // `assertWritableGenerationFile`; reaching here means an older project, and
    // the always-available set is the safe reading.
    return PREVIEW_DEPS;
  }
  if (!declared || typeof declared !== 'object' || !('dependencies' in declared)) {
    return PREVIEW_DEPS;
  }
  const dependencies: unknown = declared.dependencies;
  if (!dependencies || typeof dependencies !== 'object') return PREVIEW_DEPS;
  const extra: Record<string, string> = {};
  for (const name of Object.keys(dependencies)) {
    const pinned = OPTIONAL_PREVIEW_DEPS[name];
    if (pinned) extra[name] = pinned;
  }
  return Object.keys(extra).length > 0 ? { ...PREVIEW_DEPS, ...extra } : PREVIEW_DEPS;
}

export function packageNameOf(specifier: string) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}
