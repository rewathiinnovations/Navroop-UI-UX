import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/shadcn/dropdown-menu';
import PreviewDeviceToolbar from '@/components/workspace/PreviewDeviceToolbar';
import { PREVIEW_DEVICES } from '@/lib/preview/devices';

/**
 * The shipped device control. It replaced a `role="radiogroup"` row of
 * icon-only pills, so the swap introduced something the pills never had to do:
 * pick one device to name on a single trigger. The pills were the only
 * control and the menu had no test at all, so the coverage lands here with
 * the behaviour — the pills are gone, and only what ships is asserted.
 *
 * The menu panel is portaled by Radix and never reaches server markup, so the
 * items are asserted on the element tree the component returns (through
 * `renderHookOnce`, since the menu owns its `open` state) while the trigger,
 * which does render, keeps its markup assertions.
 */
describe('the header device menu', () => {
  type ToolbarProps = Parameters<typeof PreviewDeviceToolbar>[0];

  function props(overrides?: Partial<ToolbarProps>): ToolbarProps {
    return {
      device: 'desktop',
      rotated: false,
      sizeLabel: '',
      scaleLabel: null,
      onDeviceChange: () => {},
      onToggleRotate: () => {},
      ...overrides,
    };
  }

  function tree(overrides?: Partial<ToolbarProps>) {
    return renderHookOnce(() => PreviewDeviceToolbar(props(overrides)));
  }

  function markup(overrides?: Partial<ToolbarProps>) {
    return renderToStaticMarkup(createElement(PreviewDeviceToolbar, props(overrides)));
  }

  it('names the current device on the trigger, not as an icon-only control', () => {
    // Hint tooltips on the old icon pills already said "Desktop"; the trigger
    // itself has to carry the name, which is what a closed dropdown still shows.
    expect(markup({ device: 'desktop' })).toContain('aria-label="Preview device: Desktop"');
    expect(markup({ device: 'desktop' })).toContain('>Desktop<');
    expect(markup({ device: 'mobile' })).toContain('aria-label="Preview device: Mobile"');
    expect(markup({ device: 'tablet' })).toContain('aria-label="Preview device: Tablet"');
  });

  it('reserves the same trigger min-width for every device, so the header does not shift', () => {
    // "Desktop" is the longest label. Without a reserved width the button
    // shrinks for Mobile/Tablet and every neighbour (rotate, page picker)
    // jumps sideways. The class is the contract — same token on all three.
    const className = 'min-w-[110px]';
    expect(markup({ device: 'desktop' })).toContain(className);
    expect(markup({ device: 'mobile' })).toContain(className);
    expect(markup({ device: 'tablet' })).toContain(className);
  });

  it('names the trigger as a menu the keyboard can open', () => {
    const closed = markup({ device: 'desktop' });
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('<button type="button"');
    expect(closed).not.toContain('role="radiogroup"');
  });

  it('offers the three devices as named radio items, in order', () => {
    const items = elementsOfType(tree({ device: 'desktop' }), DropdownMenuRadioItem);

    expect(items.map((item) => item.props.value)).toEqual(
      PREVIEW_DEVICES.map((device) => device.key),
    );
    expect(items.map((item) => textOf(item.props.children))).toEqual(
      PREVIEW_DEVICES.map((device) => device.label),
    );
  });

  it('reports which device is showing, through the group and on the trigger', () => {
    const [group] = elementsOfType(tree({ device: 'tablet' }), DropdownMenuRadioGroup);
    expect(group.props.value).toBe('tablet');
    expect(markup({ device: 'tablet' })).toContain('>Tablet<');
  });

  it('reports the chosen device upward when the group changes', () => {
    const onDeviceChange = vi.fn();
    const [group] = elementsOfType(
      tree({ device: 'desktop', onDeviceChange }),
      DropdownMenuRadioGroup,
    );

    (group.props.onValueChange as (value: string) => void)('mobile');
    expect(onDeviceChange).toHaveBeenCalledWith('mobile');
  });

  it('keeps rotate for a sized device and hides it on desktop', () => {
    const mobile = markup({ device: 'mobile' });
    expect(mobile).toContain('aria-label="Rotate preview"');
    expect(mobile).toContain('shrink-0');
    expect(markup({ device: 'tablet', rotated: true })).toContain('aria-pressed="true"');
    expect(markup({ device: 'desktop' })).not.toContain('aria-label="Rotate preview"');
  });

  it('still shows the scale-to-fit label when the frame is smaller than the device', () => {
    expect(markup({ device: 'mobile', scaleLabel: '75%' })).toContain('75%');
  });
});

describe('the device toolbar declares no menu role it does not implement', () => {
  const file = 'components/workspace/PreviewDeviceToolbar.tsx';

  it(`${file} is a Radix dropdown, not a hand-rolled menu`, () => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/role=["']menu/);
    expect(source).toContain("from '@/components/ui/shadcn/dropdown-menu'");
  });
});

/**
 * Renders a hook once through the server renderer and hands back what it returned.
 * `useState`/`useCallback` work; effects do not run, which is what makes this usable
 * for a callback the user triggers by hand.
 */
function renderHookOnce<T>(use: () => T): T {
  const captured: T[] = [];
  function Probe() {
    captured.push(use());
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (captured.length === 0) throw new Error('the hook never ran');
  return captured[0]!;
}

/** Every element of `type` in the tree, outermost first. */
function elementsOfType(
  node: unknown,
  type: unknown,
  found: { props: Record<string, unknown> }[] = [],
): { props: Record<string, unknown> }[] {
  if (Array.isArray(node)) {
    for (const child of node) elementsOfType(child, type, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (!element.props) return found;
  if (element.type === type) found.push({ props: element.props });
  elementsOfType(element.props.children, type, found);
  return found;
}

/** The visible text of an item, ignoring the icon element beside it. */
function textOf(children: unknown): string {
  if (typeof children === 'string') return children.trim();
  if (Array.isArray(children)) return children.map(textOf).join('').trim();
  return '';
}
