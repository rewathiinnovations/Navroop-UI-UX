/**
 * Regenerate `lib/generation/lucide-icon-names.ts` from the installed
 * `lucide-react`.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/generate-lucide-icon-names.ts
 *
 * Why a vendored list rather than a runtime import: the check that uses it runs
 * inside the generation route on every build, and `lucide-react`'s type
 * declaration is 2 MB. Reading it per request would be absurd, and importing the
 * runtime module server-side pulls ~1,600 React components into the API bundle
 * to ask a question about their names.
 *
 * The list is deliberately a *subset* of what the preview serves
 * (`lib/preview/deps.ts` pins a newer lucide-react on esm.sh). Lucide adds icons
 * in minor releases and does not remove them, so every name here exists in the
 * served version too: a name missing from this list is either genuinely invalid
 * or very new, and in both cases substituting a known-good icon is the right
 * outcome for a build that must render on the first try.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function iconNames(): { version: string; names: string[] } {
  const packageJsonPath = require.resolve('lucide-react/package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  const declaration = join(dirname(packageJsonPath), 'dist', 'lucide-react.d.ts');
  const source = readFileSync(declaration, 'utf8');

  const block = source.slice(source.lastIndexOf('export {'));
  const match = /export \{([\s\S]*?)\};/.exec(block);
  if (!match) throw new Error('lucide-react.d.ts: no trailing export block found');

  const names = new Set<string>();
  for (const entry of match[1].split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // `Foo as FooIcon` exports the alias; `Foo` exports itself.
    const exported = trimmed.includes(' as ') ? trimmed.split(' as ')[1].trim() : trimmed;
    // Types and helpers are exported from the same block. Only PascalCase
    // component names are icons a generated project can render.
    if (/^[A-Z][A-Za-z0-9]*$/.test(exported)) names.add(exported);
  }
  return { version: pkg.version, names: [...names].sort() };
}

const { version, names } = iconNames();

const banner = `/**
 * Every icon name \`lucide-react\` exports, vendored.
 *
 * DO NOT EDIT BY HAND — run:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/generate-lucide-icon-names.ts
 *
 * Generated from lucide-react@${version}. See the script for why this is a
 * subset of the version \`lib/preview/deps.ts\` serves, and why that is safe.
 *
 * Stored as one space-separated string and split on first use: a 1,600-entry
 * array literal costs the parser far more than one string does, and every
 * consumer wants a Set anyway.
 */`;

const body = `${banner}
export const LUCIDE_SOURCE_VERSION = '${version}';

const NAMES =
  '${names.join(' ')}';

let cache: Set<string> | null = null;

/** Lazily built so importing this module costs one string, not a Set of 1,600. */
export function lucideIconNames(): ReadonlySet<string> {
  if (!cache) cache = new Set(NAMES.split(' '));
  return cache;
}

export function isLucideIcon(name: string): boolean {
  return lucideIconNames().has(name);
}
`;

const out = join(process.cwd(), 'lib', 'generation', 'lucide-icon-names.ts');
writeFileSync(out, body);
process.stdout.write(`wrote ${out} (${names.length} names from lucide-react@${version})\n`);
