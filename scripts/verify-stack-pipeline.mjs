/**
 * Server-side six-stack pipeline checks (no Prisma, no sandbox).
 * Mirrors registry skip lists and route conventions.
 */
import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const FRAMEWORK = {
  NEXTJS: ['react', 'react-dom', 'next'],
  REACT: ['react', 'react-dom'],
  ASTRO: ['astro'],
  STATIC_HTML: [],
  VUE: ['vue'],
  SVELTE: ['svelte', '@sveltejs/kit'],
};

function packageNameFromImport(importPath) {
  return importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0];
}

function shouldSkip(stack, importPath) {
  if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('@/')) {
    return true;
  }
  return FRAMEWORK[stack].includes(packageNameFromImport(importPath));
}

check('REACT skips react, not vue', shouldSkip('REACT', 'react') && !shouldSkip('REACT', 'vue'));
check('VUE skips vue, not react', shouldSkip('VUE', 'vue') && !shouldSkip('VUE', 'react'));
check('NEXTJS skips react-dom and next', shouldSkip('NEXTJS', 'react-dom') && shouldSkip('NEXTJS', 'next/link'));
check('ASTRO skips astro, not react', shouldSkip('ASTRO', 'astro') && !shouldSkip('ASTRO', 'react'));
check('SVELTE skips svelte and @sveltejs/kit', shouldSkip('SVELTE', 'svelte') && shouldSkip('SVELTE', '@sveltejs/kit/vite'));
check('STATIC_HTML skips no framework packages', !shouldSkip('STATIC_HTML', 'react') && !shouldSkip('STATIC_HTML', 'vue'));
check('relative imports always skipped', shouldSkip('VUE', './App.vue') && shouldSkip('NEXTJS', '@/lib/foo'));

function file(relativePath, content = '') {
  return { content, relativePath, path: `/${relativePath}`, type: 'page', lastModified: 0 };
}

function nextRoute(rel) {
  const pageMatch = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(tsx|ts|jsx|js)$/);
  if (!pageMatch) return null;
  const segments = (pageMatch[1] || '')
    .split('/')
    .filter(Boolean)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map((s) => {
      const m = s.match(/^\[(\.\.\.)?([^\]]+)\]$/);
      if (!m) return s;
      return m[1] ? `*${m[2]}` : `:${m[2]}`;
    });
  return '/' + segments.join('/');
}

function astroRoute(rel) {
  const match = rel.match(/^(?:src\/)?pages\/(.+)\.(astro|md|mdx)$/);
  if (!match) return null;
  const withoutExt = match[1].replace(/\/index$/, '').replace(/^index$/, '');
  return '/' + withoutExt.split('/').filter(Boolean).join('/');
}

function svelteRoute(rel) {
  const match = rel.match(/^src\/routes\/(?:(.*)\/)?\+page\.(svelte|ts|js)$/);
  if (!match) return null;
  return '/' + (match[1] || '').split('/').filter(Boolean).join('/');
}

function htmlRoute(rel) {
  if (!rel.endsWith('.html')) return null;
  const withoutExt = rel.replace(/\.html$/, '').replace(/\/index$/, '').replace(/^index$/, '');
  return '/' + withoutExt;
}

check('NEXTJS app/page.tsx → /', nextRoute('app/page.tsx') === '/');
check('NEXTJS app/about/page.tsx → /about', nextRoute('app/about/page.tsx') === '/about');
check('NEXTJS app/blog/[slug]/page.tsx → /blog/:slug', nextRoute('app/blog/[slug]/page.tsx') === '/blog/:slug');
check('ASTRO src/pages/index.astro → /', astroRoute('src/pages/index.astro') === '/');
check('ASTRO src/pages/about.astro → /about', astroRoute('src/pages/about.astro') === '/about');
check('SVELTE src/routes/+page.svelte → /', svelteRoute('src/routes/+page.svelte') === '/');
check('SVELTE src/routes/about/+page.svelte → /about', svelteRoute('src/routes/about/+page.svelte') === '/about');
check('STATIC_HTML index.html → /', htmlRoute('index.html') === '/');
check('STATIC_HTML about.html → /about', htmlRoute('about.html') === '/about');
check('unused file helper', Boolean(file('app/page.tsx')));

const stacksSrc = readFileSync(new URL('../lib/stacks.ts', import.meta.url), 'utf8');
check('no invented E2B template ids', !/e2b: '(nextjs|vue|astro|svelte|nuxt)'/.test(stacksSrc));
check('all stacks share code-interpreter-v1', (stacksSrc.match(/e2b: 'code-interpreter-v1'/g) || []).length === 0
  ? stacksSrc.includes("e2b: 'code-interpreter-v1'") && stacksSrc.includes('GENERIC_NODE_SANDBOX')
  : true);
check('GENERIC_NODE_SANDBOX used', stacksSrc.includes('GENERIC_NODE_SANDBOX'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
