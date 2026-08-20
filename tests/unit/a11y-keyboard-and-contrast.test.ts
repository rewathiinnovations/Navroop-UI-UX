import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import colors from 'tailwindcss/colors';
import { listAnnouncement } from '@/lib/a11y/list-announcement';

/**
 * Keyboard and contrast defects the a11y audit confirmed by hand (F-408 to
 * F-434). Each assertion below is the shape of the original bug, so the bug
 * cannot come back by copy-paste:
 *
 * - `Accordion` derived its panel id from the title, so `/admin/templates`
 *   emitted one `id="accordion-edit-prompt"` per template row, and left the
 *   collapsed textareas in the tab order.
 * - The usage "by member" drill-down — the reason that page exists — was a bare
 *   `<tr onClick>`, unreachable without a mouse.
 * - Four popovers declared `role="menu"` while implementing none of the
 *   WAI-ARIA menu keyboard contract.
 * - Nothing announced a list settling, so a screen reader was silent between
 *   navigation and the cards appearing.
 * - motion's `repeat: Infinity` kept spinning under "Reduce motion", because
 *   reset.css only neutralises *CSS* animations.
 * - The one pill colour that means "needs attention" was the hardest to read.
 */

function source(path: string) {
  return readFileSync(path, 'utf8');
}

/** Relative luminance per WCAG 2.1, from an 8-bit sRGB triple. */
function luminance([r, g, b]: number[]) {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(a: number[], b: number[]) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function rgb(hex: string) {
  const raw = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16));
}

/** `bg-<colour>/<alpha>` composited over an opaque backdrop. */
function composite(foreground: number[], backdrop: number[], alpha: number) {
  return foreground.map((channel, index) => alpha * channel + (1 - alpha) * backdrop[index]);
}

const amber = colors.amber as Record<string, string>;

describe('Accordion (F-408)', () => {
  const accordion = source('components/admin/Accordion.tsx');

  it('takes the panel id from useId, not the title', () => {
    // `TemplatesAdmin` renders <Accordion title="Edit prompt"> per row.
    expect(accordion).not.toContain('title.replace');
    expect(accordion).toContain('useId()');
  });

  it('takes the collapsed panel out of the tab order and the a11y tree', () => {
    expect(accordion).toContain('inert={!open}');
    expect(accordion).toContain('grid-rows-[0fr] invisible');
  });
});

describe('usage by-member drill-down (F-409)', () => {
  it('the toggle is a button carrying aria-expanded and aria-controls', () => {
    const usage = source('app/(app)/admin/usage/UsageDashboard.tsx');
    expect(usage).toContain('aria-expanded={isOpen}');
    expect(usage).toContain('aria-controls={detailId}');
    expect(usage).not.toMatch(/<Tr[^>]*onClick/);
  });

  it('Tr no longer accepts onClick, so the mouse-only pattern cannot be copied', () => {
    expect(source('components/admin/AdminTable.tsx')).not.toMatch(
      /export function Tr[\s\S]{0,400}onClick/,
    );
  });
});

describe('popovers stop claiming to be menus they are not (F-410)', () => {
  // The two mixed-content account popovers keep their visual design and get a
  // real disclosure contract; the two that really are command lists move onto
  // the Radix DropdownMenu already vendored in the repo.
  const disclosures = ['components/app/studio/UserMenu.tsx', 'components/layout/AccountMenu.tsx'];
  const radixMenus = ['components/layout/WorkspaceDropdown.tsx', 'app/(app)/projects/page.tsx'];

  it.each([...disclosures, ...radixMenus])('%s declares no hand-rolled menu role', (path) => {
    const code = source(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(code).not.toMatch(/role=["'](menu|menuitem)["']/);
  });

  it.each(disclosures)('%s moves focus into the panel and restores it', (path) => {
    const code = source(path);
    expect(code).toContain('useDisclosurePopover');
    expect(code).toContain('aria-controls={panelId}');
    expect(code).toContain('onBlurCapture={onBlurCapture}');
  });

  it('the disclosure hook focuses the panel, restores on Escape, and closes on focus-out', () => {
    const hook = source('hooks/useDisclosurePopover.ts');
    expect(hook).toContain('querySelector<HTMLElement>(FOCUSABLE)?.focus()');
    expect(hook).toMatch(/Escape[\s\S]{0,160}triggerRef\.current\?\.focus\(\)/);
    expect(hook).toContain('onBlurCapture');
  });

  it.each(radixMenus)('%s runs on the Radix DropdownMenu', (path) => {
    expect(source(path)).toContain('DropdownMenuTrigger');
  });

  it('the /projects Create popover no longer relies on a document click to dismiss', () => {
    expect(source('app/(app)/projects/page.tsx')).not.toContain("addEventListener('click'");
  });
});

describe('async list transitions are announced (F-426)', () => {
  it.each([
    'app/(app)/projects/page.tsx',
    'app/(app)/dashboard/page.tsx',
    'components/settings/SkillsPanel.tsx',
    'app/(app)/admin/audit/AuditAdmin.tsx',
  ])('%s carries a polite live region', (path) => {
    expect(source(path)).toContain('aria-live="polite"');
  });

  it('announces the settled count, and stays quiet while loading', () => {
    expect(listAnnouncement({ loading: true, error: '', count: 0, noun: 'project' })).toBe('');
    expect(listAnnouncement({ loading: false, error: '', count: 0, noun: 'project' })).toBe(
      'No projects found',
    );
    expect(listAnnouncement({ loading: false, error: '', count: 1, noun: 'project' })).toBe(
      '1 project',
    );
    expect(listAnnouncement({ loading: false, error: '', count: 12, noun: 'project' })).toBe(
      '12 projects',
    );
  });

  it('says nothing on failure — the error paragraph already has role="alert"', () => {
    expect(
      listAnnouncement({
        loading: false,
        error: 'Could not load projects',
        count: 0,
        noun: 'project',
      }),
    ).toBe('');
  });
});

describe('motion spinners honour prefers-reduced-motion (F-433)', () => {
  it.each([
    'components/CodeApplicationProgress.tsx',
    'components/app/(home)/sections/ai-readiness/InlineResults.tsx',
    'components/shared/ui/dot-grid-loader.tsx',
  ])('%s gates every repeat: Infinity on useReducedMotion', (path) => {
    const code = source(path);
    expect(code).toContain('repeat: Infinity');
    expect(code).toContain('useReducedMotion');
    // Every infinite transition sits behind the reduced-motion flag rather than
    // being handed to motion unconditionally. The flag can be a few lines up,
    // on the `?` of the ternary that chooses the transition.
    const lines = code.replace(/^\s*\/\/.*$/gm, '').split('\n');
    const infinite = lines.filter((line) => line.includes('repeat: Infinity'));
    expect(infinite.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      if (!line.includes('repeat: Infinity')) continue;
      expect(lines.slice(Math.max(0, index - 3), index + 1).join('\n')).toMatch(
        /reduceMotion|looping/,
      );
    }
  });
});

describe('the warning StatusPill meets AA (F-434)', () => {
  const pill = source('components/admin/StatusPill.tsx');
  const warning = pill.slice(pill.indexOf('warning:'), pill.indexOf('danger:'));
  // `--studio-surface` in `components/app/studio/studio.css`: white in light,
  // rgba(255,255,255,0.045) over #0c0c0e in dark.
  const lightBackdrop = rgb('#ffffff');
  const darkBackdrop = composite(rgb('#ffffff'), rgb('#0c0c0e'), 0.045);

  it('still paints a 10% amber tint, which is what the text sits on', () => {
    expect(warning).toContain('bg-amber-500/10');
  });

  it('clears 4.5:1 in light mode — the product default — at 11px', () => {
    const shade = warning.match(/(?<!dark:)text-amber-(\d+)/)?.[1];
    expect(shade).toBeDefined();
    const tint = composite(rgb(amber['500']), lightBackdrop, 0.1);
    // The shipped colour, and the one it replaced.
    expect(contrastRatio(rgb(amber[shade!]), tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(amber['600']), tint)).toBeLessThan(4.5);
  });

  it('clears 4.5:1 in dark mode too', () => {
    const shade = warning.match(/dark:text-amber-(\d+)/)?.[1];
    expect(shade).toBeDefined();
    const tint = composite(rgb(amber['500']), darkBackdrop, 0.1);
    expect(contrastRatio(rgb(amber[shade!]), tint)).toBeGreaterThanOrEqual(4.5);
  });
});
