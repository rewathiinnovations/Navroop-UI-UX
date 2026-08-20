import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Link from 'next/link';
import { describe, expect, it } from 'vitest';
import StatTile from '@/components/admin/StatTile';
import Spinner, { SPINNER_SIZES, type SpinnerSize } from '@/components/ui/spinner';
import Tabs from '@/components/shared/tabs/Tabs';

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
 * F-441: the size map read `{ sm: h-4, md: h-20, lg: h-8 }`. Tailwind runs on a px
 * scale here, so that is 4 px / 20 px / 8 px — `lg` smaller than `md` and `sm`
 * effectively invisible. The invariant, not the literals, is what must hold.
 */
describe('Spinner sizes grow with their names', () => {
  const px = (size: SpinnerSize) => {
    const match = SPINNER_SIZES[size].match(/^h-(\d+) w-\1$/);
    if (!match) throw new Error(`${size} is not a square px size: ${SPINNER_SIZES[size]}`);
    return Number(match[1]);
  };

  it('orders sm < md < lg', () => {
    expect(px('sm')).toBeLessThan(px('md'));
    expect(px('md')).toBeLessThan(px('lg'));
  });

  it('keeps every size large enough to be seen', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(px(size)).toBeGreaterThanOrEqual(12);
    }
  });

  it('paints the class for the size it was asked for', () => {
    const markup = renderToStaticMarkup(createElement(Spinner, { size: 'lg' }));
    expect(markup).toContain(SPINNER_SIZES.lg);
  });

  it('leaves the default caller untouched at 20 px', () => {
    expect(renderToStaticMarkup(createElement(Spinner, {}))).toContain(SPINNER_SIZES.md);
  });
});

/**
 * F-443: a row of plain `<button>`s with no `role`, no `aria-selected` and no
 * arrow-key movement. Assistive tech saw an undifferentiated button row and the
 * whole group was one Tab stop per button rather than one stop for the group.
 */
describe('the shared Tabs has real tab semantics', () => {
  const TABS = [
    { value: 'one', label: 'One', panelId: 'panel-one' },
    { value: 'two', label: 'Two' },
    { value: 'three', label: 'Three' },
  ];

  const markup = renderToStaticMarkup(
    createElement(Tabs, {
      tabs: TABS,
      activeTab: 'two',
      setActiveTab: () => {},
      label: 'Plans',
    }),
  );

  it('groups the buttons in a named tablist', () => {
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Plans"');
  });

  it('marks every button a tab and exactly one of them selected', () => {
    expect(markup.match(/role="tab"/g)).toHaveLength(TABS.length);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-selected="false"/g)).toHaveLength(TABS.length - 1);
  });

  it('roves the tabIndex so the group is a single Tab stop', () => {
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(TABS.length - 1);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('points at a panel only when the consumer named one', () => {
    expect(markup.match(/aria-controls="panel-one"/g)).toHaveLength(1);
    expect(markup.match(/aria-controls=/g)).toHaveLength(1);
  });

  it('moves selection and focus together on arrow, Home and End', () => {
    const source = read('components/shared/tabs/Tabs.tsx');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(source).toContain(`"${key}"`);
    }
    expect(source).toContain('onKeyDown={(event) => onKeyDown(event, index)}');
  });

  it('keys on the tab value, so reordering does not remount the wrong tab', () => {
    expect(read('components/shared/tabs/Tabs.tsx')).not.toContain('key={index}');
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
