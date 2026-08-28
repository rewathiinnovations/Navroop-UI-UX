import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/shadcn/dropdown-menu';
import {
  WORKSPACE_PRIMARY_TABS,
  WORKSPACE_TABS,
  WORKSPACE_TOOL_TABS,
  type Checkpoint,
  type WorkspaceView,
} from '@/components/workspace/types';
import {
  VERSION_PILL_LIMIT,
  VersionMenu,
  WorkspaceToolMenu,
  WorkspaceViewSwitch,
  versionPillList,
} from '@/components/workspace/WorkspaceViewControls';
import { useCheckpoints } from '@/components/workspace/useCheckpoints';

describe('workspace top bar tabs', () => {
  it('keeps Preview and Code as the only primary tabs', () => {
    expect(WORKSPACE_PRIMARY_TABS.map((tab) => tab.id)).toEqual(['preview', 'code']);
  });

  /**
   * The switch is icon-only. The names stay on `aria-label` / `title` so a
   * `getByRole('tab', { name: 'Preview' })` still finds them; the visible
   * "Preview" / "Code" labels must not come back.
   */
  it('renders the primary switch as named icon-only tabs', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceViewSwitch, {
        view: 'preview',
        onViewChange: () => {},
      }),
    );

    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('aria-label="Code"');
    expect(html).toContain('title="Preview"');
    expect(html).toContain('title="Code"');
    expect(html).toMatch(/aria-label="Preview"[^>]*aria-selected="true"/);
    expect(html).toMatch(/aria-label="Code"[^>]*aria-selected="false"/);
    // Visible text would sit between tags as `>Preview<` / `>Code<`. Attribute
    // values still carry the English names above.
    const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    expect(withoutSvg).not.toContain('>Preview<');
    expect(withoutSvg).not.toContain('>Code<');
    // More views is a sibling in the top-bar cluster, not glued to this pair.
    expect(html).not.toContain('More views');
  });

  it('paints the selected Preview/Code tab with the flame CTA tokens', () => {
    const preview = renderToStaticMarkup(
      createElement(WorkspaceViewSwitch, {
        view: 'preview',
        onViewChange: () => {},
      }),
    );
    const code = renderToStaticMarkup(
      createElement(WorkspaceViewSwitch, {
        view: 'code',
        onViewChange: () => {},
      }),
    );

    expect(preview).toMatch(
      /aria-label="Preview"[^>]*\[background-image:var\(--studio-cta-gradient\)\]/,
    );
    expect(preview).toMatch(/aria-label="Preview"[^>]*text-\[var\(--studio-cta-fg\)\]/);
    expect(preview).toMatch(/aria-label="Code"[^>]*text-\[var\(--studio-muted\)\]/);
    expect(preview).not.toMatch(
      /aria-label="Code"[^>]*\[background-image:var\(--studio-cta-gradient\)\]/,
    );

    expect(code).toMatch(/aria-label="Code"[^>]*\[background-image:var\(--studio-cta-gradient\)\]/);
    expect(code).toMatch(/aria-label="Code"[^>]*text-\[var\(--studio-cta-fg\)\]/);
    expect(code).not.toMatch(
      /aria-label="Preview"[^>]*\[background-image:var\(--studio-cta-gradient\)\]/,
    );
  });

  it('keeps Quality, Assets, Brain, and Domains as the overflow views', () => {
    expect(WORKSPACE_TOOL_TABS.map((tab) => tab.id)).toEqual(['seo', 'assets', 'brain', 'domains']);
  });

  it('lists every workspace view exactly once', () => {
    const ids = WORKSPACE_TABS.map((tab) => tab.id);
    expect(ids).toEqual(['preview', 'code', 'seo', 'assets', 'brain', 'domains']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Preview/Code became the primary switch and the other four moved behind an overflow.
 * They were icon-only buttons with `aria-label`s before, so the one thing that must
 * not be lost in the move is that each of the four is still a real focusable control
 * with a name — a menu that renders three of them, or renders them as unnamed icons,
 * is a view a keyboard or screen-reader user can no longer reach at all.
 *
 * The menu ran on a hand-rolled `role="menu"` div until N-016; it is a Radix
 * `DropdownMenuRadioGroup` now, so the panel is portaled and never appears in
 * server markup. The four items are therefore asserted on the element tree the
 * component returns — which pins the value each item carries and the callback the
 * group reports through, not just a substring — and the trigger, which does render
 * on the server, keeps its markup assertions.
 */
describe('the view overflow keeps every secondary view reachable', () => {
  function tree(view: WorkspaceView) {
    return WorkspaceToolMenu({
      view,
      open: true,
      onViewChange: () => {},
      onOpenChange: () => {},
    });
  }

  function markup(view: WorkspaceView, open: boolean) {
    return renderToStaticMarkup(
      createElement(WorkspaceToolMenu, {
        view,
        open,
        onViewChange: () => {},
        onOpenChange: () => {},
      }),
    );
  }

  it('offers all four as named radio items, in order', () => {
    const items = elementsOfType(tree('preview'), DropdownMenuRadioItem);

    expect(items.map((item) => item.props.value)).toEqual(WORKSPACE_TOOL_TABS.map((tab) => tab.id));
    // A name, not a bare icon: an unlabelled item is a view nobody can find.
    expect(items.map((item) => textOf(item.props.children))).toEqual(
      WORKSPACE_TOOL_TABS.map((tab) => tab.label),
    );
  });

  it('reports which of the four is showing, through the group and on the trigger', () => {
    const [group] = elementsOfType(tree('brain'), DropdownMenuRadioGroup);
    expect(group.props.value).toBe('brain');

    // Closed, the trigger is the only thing left saying where the reader is. Without
    // this the header claimed nothing was selected while a Brain panel filled the pane.
    const closed = markup('brain', false);
    expect(closed).toContain('aria-label="Brain — more views"');
    expect(closed).toContain('aria-expanded="false"');
  });

  it('carries no selection while Preview or Code is showing', () => {
    const [group] = elementsOfType(tree('code'), DropdownMenuRadioGroup);
    // `code` is a primary tab, so none of the four overflow views is checked.
    expect(WORKSPACE_TOOL_TABS.map((tab) => tab.id)).not.toContain(group.props.value);
    expect(markup('code', false)).toContain('aria-label="More views"');
  });

  it('names the trigger as a menu trigger the keyboard can open', () => {
    const closed = markup('code', false);
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('<button type="button"');
  });

  it('reports the chosen view upward when the group changes', () => {
    const chosen: WorkspaceView[] = [];
    const [group] = elementsOfType(
      WorkspaceToolMenu({
        view: 'preview',
        open: true,
        onViewChange: (next) => chosen.push(next),
        onOpenChange: () => {},
      }),
      DropdownMenuRadioGroup,
    );

    (group.props.onValueChange as (value: string) => void)('domains');
    expect(chosen).toEqual(['domains']);
  });
});

/**
 * N-016: three popovers in the workspace header declared `role="menu"` (one of them
 * `role="menuitemradio"`) while implementing none of the WAI-ARIA menu keyboard
 * contract — opening did not move focus, arrows and Home/End did nothing, there was
 * no roving tabIndex, and Escape dropped focus on `<body>` rather than returning it
 * to the trigger. Radix owns all three now. A hand-written menu role reappearing in
 * this chrome is the regression, so it is asserted against the source.
 */
describe('the workspace header declares no menu role it does not implement', () => {
  for (const file of [
    'components/workspace/WorkspaceTopBar.tsx',
    'components/workspace/WorkspaceViewControls.tsx',
  ]) {
    it(`${file} has no hand-rolled menu role`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      // Comments in both files explain the old markup, so the scan runs on code
      // only — otherwise the explanation of the fix would fail the guard for it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      expect(code).not.toMatch(/role=["']menu/);
      expect(source).toContain("from '@/components/ui/shadcn/dropdown-menu'");
    });
  }

  /**
   * N-024: the third popover in the same header — the GitHub connect panel — is a
   * paragraph plus a link, so it is a disclosure rather than a menu. It kept its
   * own `mousedown` + Escape listener after the other two moved to Radix, which
   * meant opening it did not move focus, Escape left focus on `<body>`, and
   * tabbing past it left the panel open behind the page. Every popover in this
   * header now delegates its keyboard contract, so a re-appearing document-level
   * listener is the regression to catch.
   */
  it('routes the connect disclosure through useDisclosurePopover, not its own listeners', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/workspace/WorkspaceTopBar.tsx'),
      'utf8',
    );
    expect(source).toContain("from '@/hooks/useDisclosurePopover'");
    expect(source).not.toContain("document.addEventListener('mousedown'");
    expect(source).not.toContain("document.addEventListener('keydown'");
    // The trigger has to name the panel it opens, and take focus back on Escape.
    expect(source).toContain('ref={connectTriggerRef}');
    expect(source).toContain('aria-controls={connectPanelId}');
    expect(source).toContain('onBlurCapture={onConnectBlurCapture}');
  });
});

/**
 * The header used to put Version + page picker beside Preview/Code while the
 * device dropdown lived on the far right, which is how the icons stacked on
 * each other around 1024. Order is asserted on the source (WorkspaceTopBar
 * imports a `'use server'` action) so a reorder that fights the wrap cannot
 * land quietly.
 */
describe('the primary cluster order never stacks controls', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/workspace/WorkspaceTopBar.tsx'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('keeps Preview|Code → page → device → version → more views', () => {
    const switchAt = code.indexOf('<WorkspaceViewSwitch');
    const pageAt = code.indexOf('id="workspace-page"');
    const deviceAt = code.indexOf('<PreviewDeviceToolbar');
    const versionAt = code.indexOf('<VersionMenu');
    const moreAt = code.indexOf('<WorkspaceToolMenu');

    expect(switchAt).toBeGreaterThan(-1);
    expect(pageAt).toBeGreaterThan(switchAt);
    expect(deviceAt).toBeGreaterThan(pageAt);
    expect(versionAt).toBeGreaterThan(deviceAt);
    expect(moreAt).toBeGreaterThan(versionAt);
  });

  it('documents that order and refuses a squeezed flex-1 cluster', () => {
    expect(source).toContain(
      'Primary cluster order: Preview|Code → page switcher → device → version → more views',
    );
    const clusterOpen = code.indexOf('<WorkspaceViewSwitch');
    const clusterWrap = code.lastIndexOf(
      'className="flex max-w-full shrink-0 flex-wrap items-center gap-6"',
      clusterOpen,
    );
    expect(clusterWrap).toBeGreaterThan(-1);
    expect(code.slice(clusterWrap, clusterOpen)).not.toContain('flex-1');
    // Icon chrome keeps a 44px box that cannot collapse under a neighbour.
    expect(source).toMatch(/const ICON_BTN =\s*'studio-icon-hit inline-flex shrink-0 /);
    expect(code).toContain(
      'ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-6',
    );
  });

  it('keeps remaining actions after the More views overflow', () => {
    const moreAt = code.indexOf('<WorkspaceToolMenu');
    const refreshAt = code.indexOf('aria-label="Refresh preview"');
    const downloadAt = code.indexOf('aria-label="Download code"');
    expect(refreshAt).toBeGreaterThan(moreAt);
    expect(downloadAt).toBeGreaterThan(refreshAt);
  });
});

/**
 * Below 900px `compactActions` hides the standalone Share button, so the overflow
 * menu is the only route Share has left — with no item there, Share is unreachable
 * by pointer and by keyboard alike on a tablet. `main` found that hole while the
 * N-016 Radix port was in flight on this branch, so the item closing it arrived with
 * the merge; it is pinned here rather than left for the next merge to drop quietly.
 *
 * Asserted against the source, not a render: `WorkspaceTopBar` imports the
 * `'use server'` `pushProjectToGitHub` action, so mounting it in a unit test pulls
 * prisma and the auth stack in with it. That is the same reason the N-016 scan above
 * reads the file instead of importing it.
 */
describe('Share survives the header going compact', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/workspace/WorkspaceTopBar.tsx'),
    'utf8',
  );
  // The comments here describe the hole being closed, so the scan reads code only.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  /** Collapsed to one line, so neither assertion breaks on a reformat. */
  const flat = code.replace(/\s+/g, ' ');

  /** The `cond ? (…) : null` branch opening with `open`. */
  function branch(open: string) {
    const from = flat.indexOf(open);
    expect(from).toBeGreaterThan(-1);
    const rest = flat.slice(from);
    return rest.slice(0, rest.indexOf(') : null}') + ') : null}'.length);
  }

  it('hides the standalone Share button once actions go compact', () => {
    expect(branch('{!compactActions ? (')).toContain('onClick={onShare}');
  });

  it('offers Share through the overflow menu in exactly that case', () => {
    const compact = branch('{compactActions ? (');
    // A DropdownMenuItem, not a bare button: inside `DropdownMenuContent` only a
    // real item joins the menu's arrow/Home/End/Escape contract (N-016).
    expect(compact).toContain('<DropdownMenuItem');
    expect(compact).not.toContain('<button');
    expect(compact).toContain('onSelect={() => onShare?.()}');
    expect(compact).toContain('Share');
  });
});

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

const CREATED = '2026-08-19T10:00:00.000Z';

function checkpoint(id: string, overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    id,
    label: `Build ${id}`,
    thumbnailUrl: null,
    createdAt: CREATED,
    ...overrides,
  };
}

/** Newest-first, the order `getCheckpoints` returns them in. */
function history(count: number): Checkpoint[] {
  return Array.from({ length: count }, (_, index) => checkpoint(`cp-${count - index}`));
}

/**
 * The window the header's version shortcut draws from, so the two things it must get
 * right are which checkpoints it shows and what it calls them. `getCheckpoints` takes
 * no limit — thinning drops snapshots, never rows — so an unbounded list would push
 * the rest of the header off screen on any long-lived project.
 */
describe('the version window', () => {
  it('shows the newest few, newest last, and numbers them over the whole history', () => {
    const pills = versionPillList(history(9));

    expect(pills).toHaveLength(VERSION_PILL_LIMIT);
    expect(pills.map((pill) => pill.label)).toEqual(['v5', 'v6', 'v7', 'v8', 'v9']);
    // v9 is the newest checkpoint, which arrives first in the list.
    expect(pills.at(-1)?.id).toBe('cp-9');
    expect(pills[0]?.id).toBe('cp-5');
  });

  it('does not renumber a version when a newer one arrives', () => {
    const before = versionPillList(history(5));
    const after = versionPillList(history(6));

    expect(before.find((pill) => pill.label === 'v5')?.id).toBe('cp-5');
    expect(after.find((pill) => pill.label === 'v5')?.id).toBe('cp-5');
  });

  it('shows every version while there are fewer than the limit', () => {
    expect(versionPillList(history(2)).map((pill) => pill.label)).toEqual(['v1', 'v2']);
    expect(versionPillList([])).toEqual([]);
  });
});

/**
 * The shipped shortcut. It replaced a `VersionPills` row that rendered every version
 * as its own button, so the swap introduced something the pills never had to do:
 * pick one version to name on a single trigger. The pills were the tested component
 * and the menu had no test at all, so the coverage moved here with the behaviour —
 * the pills are gone, and only what ships is asserted.
 *
 * The menu panel is portaled by Radix and never reaches server markup, so the items
 * are asserted on the element tree the component returns (through `renderHookOnce`,
 * since the menu owns its `open` state) while the trigger, which does render, keeps
 * its markup assertions.
 */
describe('the header version menu', () => {
  type MenuProps = Parameters<typeof VersionMenu>[0];

  function tree(props: MenuProps) {
    return renderHookOnce(() => VersionMenu(props));
  }

  function markup(props: MenuProps) {
    return renderToStaticMarkup(createElement(VersionMenu, props));
  }

  it('names the newest version while nothing is being previewed', () => {
    // Seven checkpoints, no preview: the window is v3…v7 and it reads oldest-first,
    // so naming its first entry put 'v3' on the header while v7 filled the pane.
    const html = markup({ checkpoints: history(7), onPreview: () => {} });

    expect(html).toContain('>v7<');
    expect(html).not.toContain('>v3<');

    const [group] = elementsOfType(
      tree({ checkpoints: history(7), onPreview: () => {} }),
      DropdownMenuRadioGroup,
    );
    // Nothing is checked: naming the newest version is not the same as previewing it.
    expect(group.props.value).toBe('');
  });

  it('names the previewed version instead, even one outside the window', () => {
    // v2 is older than the newest five, which is exactly the case the trigger has to
    // survive after a reload parks the project on an old version (F-102).
    expect(markup({ checkpoints: history(7), activeId: 'cp-2', onPreview: () => {} })).toContain(
      '>v2<',
    );
  });

  it('renders nothing at all before the first checkpoint exists', () => {
    // A brand-new project opened before its first build: the pills returned `null` for
    // an empty list, and without that guard the header carried a 'Versions' trigger
    // opening a menu with zero items and no empty state.
    expect(markup({ checkpoints: [], onPreview: () => {} })).toBe('');
    expect(tree({ checkpoints: [], onPreview: () => {} })).toBeNull();
  });

  it('offers the newest few as radio items, oldest first', () => {
    const items = elementsOfType(
      tree({ checkpoints: history(7), onPreview: () => {} }),
      DropdownMenuRadioItem,
    );

    expect(items).toHaveLength(VERSION_PILL_LIMIT);
    expect(items.map((item) => item.props.value)).toEqual(['cp-3', 'cp-4', 'cp-5', 'cp-6', 'cp-7']);
  });

  it('disables a thinned version rather than offering a click the server will reject', () => {
    // `previewCheckpoint` answers a pruned checkpoint with a pruned error, so a live
    // item here would be a row whose only outcome is a failure message.
    const checkpoints = [checkpoint('cp-2'), checkpoint('cp-1', { snapshotPruned: true })];
    const items = elementsOfType(tree({ checkpoints, onPreview: () => {} }), DropdownMenuRadioItem);

    expect(items.map((item) => [item.props.value, item.props.disabled])).toEqual([
      ['cp-1', true],
      ['cp-2', false],
    ]);
  });

  it('reports the chosen version upward, and marks the one being previewed', () => {
    const onPreview = vi.fn();
    const [group] = elementsOfType(
      tree({ checkpoints: history(3), activeId: 'cp-2', onPreview }),
      DropdownMenuRadioGroup,
    );

    expect(group.props.value).toBe('cp-2');
    (group.props.onValueChange as (value: string) => void)('cp-3');
    expect(onPreview).toHaveBeenCalledWith('cp-3');
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

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * What a pill click reaches. `ProjectWorkspace` guards on `'locked' in result &&
 * result.locked` and stays silent for it, because the client has already raised the
 * LockBar — so the hook has to keep reporting that flag separately from the message,
 * or the guard silently starts swallowing real errors instead.
 */
describe('previewing a version through useCheckpoints', () => {
  it('reports a lock conflict as locked, with a message the caller can suppress', async () => {
    // The holder is what makes it a lock rather than a pruned snapshot: a 409 that
    // names nobody stays a chat line (see `checkpointRequest`).
    stubFetch(409, {
      error: 'Ada is working on this project',
      code: 'PROJECT_LOCKED',
      heldBy: { name: 'Ada' },
      expiresAt: '2026-08-19T12:00:00.000Z',
    });
    const checkpoints = renderHookOnce(() => useCheckpoints({ projectId: 'p-1' }));

    const result = await checkpoints.preview('cp-1');

    expect(result).toMatchObject({ ok: false, locked: true });
  });

  it('keeps a pruned 409 a plain failure, since no LockBar was raised for it', async () => {
    stubFetch(409, { error: 'This version is too old to restore' });
    const checkpoints = renderHookOnce(() => useCheckpoints({ projectId: 'p-1' }));

    expect(await checkpoints.preview('cp-1')).toMatchObject({
      ok: false,
      locked: false,
      error: 'This version is too old to restore',
    });
  });

  it('reports anything else as a plain failure the caller must show', async () => {
    stubFetch(500, { error: 'Snapshot storage is unreachable' });
    const checkpoints = renderHookOnce(() => useCheckpoints({ projectId: 'p-1' }));

    const result = await checkpoints.preview('cp-1');

    expect(result).toMatchObject({
      ok: false,
      locked: false,
      error: 'Snapshot storage is unreachable',
    });
  });

  it('succeeds on a 200, which is what marks the pill as the previewed version', async () => {
    stubFetch(200, { checkpoint: { id: 'cp-1' } });
    const checkpoints = renderHookOnce(() => useCheckpoints({ projectId: 'p-1' }));

    expect(await checkpoints.preview('cp-1')).toEqual({ ok: true });
  });
});
