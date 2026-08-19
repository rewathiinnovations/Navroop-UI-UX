import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_PRIMARY_TABS,
  WORKSPACE_TABS,
  WORKSPACE_TOOL_TABS,
  type Checkpoint,
  type WorkspaceView,
} from '@/components/workspace/types';
import {
  VERSION_PILL_LIMIT,
  VersionPills,
  WorkspaceToolMenu,
  versionPillList,
} from '@/components/workspace/WorkspaceViewControls';
import { useCheckpoints } from '@/components/workspace/useCheckpoints';

describe('workspace top bar tabs', () => {
  it('keeps Preview and Code as the only labeled primary tabs', () => {
    expect(WORKSPACE_PRIMARY_TABS.map((tab) => tab.id)).toEqual(['preview', 'code']);
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
 */
describe('the view overflow keeps every secondary view reachable', () => {
  function menu(view: WorkspaceView, open: boolean) {
    return renderToStaticMarkup(
      createElement(WorkspaceToolMenu, {
        view,
        open,
        onViewChange: () => {},
        onOpenChange: () => {},
      }),
    );
  }

  it('offers all four as named menu items', () => {
    const markup = menu('preview', true);

    for (const tab of WORKSPACE_TOOL_TABS) {
      expect(markup).toContain(tab.label);
    }
    expect(markup.match(/role="menuitemradio"/g)).toHaveLength(WORKSPACE_TOOL_TABS.length);
    // Buttons, not divs with click handlers: that is what makes them tabbable.
    expect(markup.match(/<button type="button" role="menuitemradio"/g)).toHaveLength(
      WORKSPACE_TOOL_TABS.length,
    );
    expect(markup).not.toContain('tabindex="-1"');
  });

  it('reports which of the four is showing, on the item and on the trigger', () => {
    const open = menu('brain', true);
    // One checked item, and it is Brain — the markup order matches WORKSPACE_TOOL_TABS.
    expect(open.match(/aria-checked="true"/g)).toHaveLength(1);
    const checked = open.slice(open.indexOf('aria-checked="true"'));
    expect(checked.slice(0, checked.indexOf('</button>'))).toContain('Brain');

    // Closed, the trigger is the only thing left saying where the reader is. Without
    // this the header claimed nothing was selected while a Brain panel filled the pane.
    const closed = menu('brain', false);
    expect(closed).toContain('aria-label="Brain — more views"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="menuitemradio"');
  });

  it('names the trigger plainly while Preview or Code is showing', () => {
    expect(menu('code', false)).toContain('aria-label="More views"');
  });
});

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
 * The pills are a shortcut to the last few checkpoints, so the two things they must
 * get right are which ones they show and what they call them. `getCheckpoints` takes
 * no limit — thinning drops snapshots, never rows — so an unbounded row would push
 * the rest of the header off screen on any long-lived project.
 */
describe('version pills', () => {
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

  it('renders one named, pressable button per version', () => {
    const markup = renderToStaticMarkup(
      createElement(VersionPills, {
        checkpoints: history(3),
        activeId: 'cp-2',
        onPreview: () => {},
      }),
    );

    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Preview v3"');
    // The previewed version is the pressed one, and only that one.
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    const pressed = markup.slice(markup.indexOf('aria-pressed="true"'));
    expect(pressed.slice(0, pressed.indexOf('</button>'))).toContain('v2');
  });

  it('refuses a thinned version instead of offering a click the server will reject', () => {
    // `previewCheckpoint` answers a pruned checkpoint with a pruned error, so a live
    // pill here would be a button whose only outcome is a failure message.
    const markup = renderToStaticMarkup(
      createElement(VersionPills, {
        checkpoints: [checkpoint('cp-1', { snapshotPruned: true })],
        onPreview: () => {},
      }),
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('snapshot removed, cannot preview');
  });

  it('hands the checkpoint id to the click handler', () => {
    const onPreview = vi.fn();
    const pills = VersionPills({ checkpoints: history(3), onPreview });
    const clicked = clickHandlers(pills);

    expect(clicked).toHaveLength(3);
    // Left to right is oldest to newest, so the last pill is the newest checkpoint.
    clicked.at(-1)?.();
    expect(onPreview).toHaveBeenCalledWith('cp-3');
  });
});

/**
 * Walks the element tree the component returned and collects every button's
 * `onClick`. There is no DOM in this suite, so this is how a click is exercised
 * without asserting on the component's internals.
 */
function clickHandlers(node: unknown, found: (() => void)[] = []): (() => void)[] {
  if (Array.isArray(node)) {
    for (const child of node) clickHandlers(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (!element.props) return found;
  if (element.type === 'button' && typeof element.props.onClick === 'function') {
    found.push(element.props.onClick as () => void);
  }
  clickHandlers(element.props.children, found);
  return found;
}

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
