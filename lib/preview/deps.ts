/**
 * Runtime dependencies for the in-browser preview, resolved from esm.sh.
 *
 * Generated apps import these as bare specifiers; the bundler keeps them
 * external and the iframe's import map points each one at esm.sh. Versions are
 * pinned so a preview cannot change under the user between reloads.
 */
export const PREVIEW_DEPS: Record<string, string> = {
  react: '19.2.0',
  'react-dom': '19.2.0',
  'lucide-react': '0.548.0',
  clsx: '2.1.1',
  'tailwind-merge': '3.4.0',
  'framer-motion': '12.23.24',
  recharts: '2.15.4',
  'date-fns': '4.1.0',
};

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

/** Packages a generated app imported that the preview cannot resolve. */
export function findUnsupportedImports(
  code: string,
  deps: Record<string, string> = PREVIEW_DEPS,
): string[] {
  const specifiers = new Set<string>();
  for (const match of code.matchAll(/from\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) {
      continue;
    }
    specifiers.add(packageNameOf(specifier));
  }
  const known = new Set(Object.keys(deps));
  return [...specifiers].filter((name) => !known.has(name)).sort();
}

export function packageNameOf(specifier: string) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}
