import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Link from 'next/link';
import { describe, expect, it } from 'vitest';
import StatTile from '@/components/admin/StatTile';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

/**
 * The same file with comments removed. Several of these components carry a comment
 * naming the literal they used to paint with, and a scan for "no raw zinc" would
 * otherwise fail on the note explaining why the zinc is gone.
 */
const codeOf = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * F-438: every stat tile on the admin home page has an internal `href`, and the
 * component rendered a raw `<a>` for it — a full document navigation, discarded
 * client state, and a visible reload on a hop that every other admin link makes
 * on the client.
 */
describe('StatTile routes internal admin links on the client', () => {
  function element(href?: string) {
    return StatTile({ icon: null, label: 'Members', value: 4, href }) as {
      type: unknown;
      props: Record<string, unknown>;
    };
  }

  it('renders next/link, not an anchor, when it links somewhere', () => {
    const tile = element('/admin/team');
    expect(tile.type).toBe(Link);
    expect(tile.type).not.toBe('a');
    expect(tile.props.href).toBe('/admin/team');
  });

  it('stays a plain div when it links nowhere', () => {
    expect(element().type).toBe('div');
  });

  it('gives the linked tile a focus ring, since it is now a keyboard stop', () => {
    expect(String(element('/admin/team').props.className)).toContain('focus-visible:ring-2');
  });
});

/**
 * F-440: `ThemeToggle` hardcoded `text-zinc-600` / `border-zinc-200` /
 * `dark:focus-visible:ring-[#ff6b8a]` next to the very tokens that define them, and
 * `LegalDraftBanner` used `amber-*` with no `dark:` pair, so the banner stayed a
 * light-mode card on `/terms` and `/privacy` in dark mode. Both hosts are
 * `.studio-shell`, so the tokens are in scope.
 */
describe('studio chrome paints with studio tokens', () => {
  it('the theme toggle names no raw zinc or hex colour', () => {
    const source = codeOf('components/app/studio/ThemeToggle.tsx');
    expect(source).not.toMatch(/zinc-\d/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(source).toContain('var(--studio-muted)');
    expect(source).toContain('var(--studio-line-strong)');
    expect(source).toContain('var(--studio-ring)');
  });

  it('the legal draft banner names no raw amber', () => {
    const source = codeOf('components/legal/LegalDraftBanner.tsx');
    expect(source).not.toMatch(/\bamber-\d/);
    expect(source).toContain('var(--studio-warning)');
  });

  it('declares the warning token in both themes, so the banner follows the palette', () => {
    const css = codeOf('components/app/studio/studio.css');
    for (const token of ['--studio-warning', '--studio-warning-soft', '--studio-warning-line']) {
      expect(css.match(new RegExp(`${token}:`, 'g'))).toHaveLength(2);
    }
  });
});

/**
 * F-442: `useState('https://coolify.navroop.app')` pre-filled one installation's
 * production Coolify host in a client component, so the hostname shipped in the
 * browser bundle of every deployment and was the wrong default for everyone else.
 * Every other connector field starts empty.
 */
describe('the integrations admin hardcodes no deployment host', () => {
  it('starts the Coolify URL field empty', () => {
    const source = read('app/(app)/admin/integrations/IntegrationsAdmin.tsx');
    expect(source).not.toContain('coolify.navroop.app');
    expect(source).toContain("const [coolifyUrl, setCoolifyUrl] = useState('')");
  });

  it('shows the shape of the value as a placeholder instead', () => {
    expect(read('app/(app)/admin/integrations/IntegrationsAdmin.tsx')).toContain(
      'placeholder="https://coolify.example.com"',
    );
  });
});
