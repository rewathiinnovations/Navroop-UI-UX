import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * A client surface that fails must say so. These five surfaces each folded a
 * failure into a state that reads as success:
 *
 * - F-425 the command palette answered "Nothing found" for a failed `/api/search`
 * - F-428 `/settings/usage` rendered blank space while loading, and discarded the
 *   server's message on a non-ok response
 * - F-429 a refused template list became `[]`, i.e. "No templates match these filters."
 * - F-431 the backups poll had no `try/catch` and promised an automatic refresh
 *   that had stopped
 * - F-436 `app/error.tsx` showed an Error ID that existed only in that browser's
 *   console
 *
 * The two loop/poll decisions are pure modules, tested directly. The render
 * branches that need a DOM are pinned by asserting on the source: the point in
 * every case is that the failure branch is *distinct from* the empty branch, and
 * that is visible in the text.
 */

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const templates = vi.hoisted(() => ({ listTemplates: vi.fn() }));
vi.mock('@/lib/auth', () => auth);
vi.mock('@/lib/templates/actions', () => templates);
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('redirect');
  }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  paletteView,
  SEARCH_SIGN_IN,
  SEARCH_UNAVAILABLE,
} from '@/components/layout/CommandPalette';
import {
  BACKUP_POLL_GAVE_UP,
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_POLL_MAX_FAILURES,
  decidePoll,
} from '@/app/(app)/admin/backups/poll-policy';
import PanelErrorBoundary from '@/components/errors/PanelErrorBoundary';
import TemplatesPage from '@/app/(app)/templates/page';
import TemplateGallery from '@/components/templates/TemplateGallery';

function source(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(node: object): node is AnyElement {
  if (!('type' in node) || !('props' in node)) return false;
  return Boolean(node.type) && typeof node.props === 'object' && node.props !== null;
}

function collectElements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (isElement(node)) {
    out.push(node);
    collectElements(node.props.children, out);
  }
  return out;
}

describe('F-425 command palette: a failed search is not an empty search', () => {
  it('a 500 or a thrown fetch renders the failed state, never "empty"', () => {
    expect(
      paletteView({
        query: 'my landing page',
        loading: false,
        failure: 'unavailable',
        resultCount: 0,
      }),
    ).toBe('failed');
  });

  it('a genuinely empty result set is still reported as empty', () => {
    expect(paletteView({ query: 'zzzz', loading: false, failure: 'none', resultCount: 0 })).toBe(
      'empty',
    );
  });

  it('a signed-out 401 is its own state, not an outage and not "Nothing found"', () => {
    // The palette is mounted in app/providers.tsx, so Cmd+K works on the landing
    // page, where /api/search answers 401 for every query.
    expect(
      paletteView({ query: 'anything', loading: false, failure: 'signedOut', resultCount: 0 }),
    ).toBe('signedOut');
    expect(SEARCH_SIGN_IN).toMatch(/sign in/i);
    expect(SEARCH_SIGN_IN).not.toMatch(/reload/i);
  });

  it('an in-flight search outranks a stale failure, so the panel does not flash an error', () => {
    expect(
      paletteView({ query: 'my site', loading: true, failure: 'unavailable', resultCount: 0 }),
    ).toBe('loading');
  });

  it('a blank query is the hint, even when the last search failed', () => {
    expect(
      paletteView({ query: '   ', loading: false, failure: 'unavailable', resultCount: 3 }),
    ).toBe('hint');
  });

  it('rows win once a retry succeeded', () => {
    expect(paletteView({ query: 'my site', loading: false, failure: 'none', resultCount: 2 })).toBe(
      'results',
    );
  });

  it('the failure copy contradicts "gone", and the panel announces it', () => {
    expect(SEARCH_UNAVAILABLE).toMatch(/unavailable/i);
    const text = source('components/layout/CommandPalette.tsx');
    // The old shape: a non-ok response returned out of the effect with the
    // result list untouched, so the empty branch rendered "Nothing found".
    expect(text).not.toContain('if (!response.ok) return;');
    expect(text).toContain("view === 'failed'");
    expect(text).toContain("view === 'signedOut'");
    expect(text).toContain("view === 'empty'");
    // 401/403 must route to the sign-in state, everything else to the outage one.
    expect(text).toContain("response.status === 401 || response.status === 403 ? 'signedOut'");
    // The failure row is the one that must reach a screen reader.
    const failedRow = text.slice(text.indexOf("view === 'failed'"));
    expect(failedRow.slice(0, 400)).toContain('role="alert"');
  });
});

describe('F-431 backup poll: it stops, and says it stopped', () => {
  it('a successful tick clears the error and the failure count', () => {
    expect(decidePoll({ failures: 2, outcome: 'ok' })).toEqual({
      failures: 0,
      stopped: false,
      message: '',
    });
  });

  it('a single transient failure keeps polling but surfaces the reason', () => {
    expect(
      decidePoll({ failures: 0, outcome: 'transient', message: 'Backup API is down' }),
    ).toEqual({ failures: 1, stopped: false, message: 'Backup API is down' });
  });

  it('consecutive transient failures give up instead of rejecting every 2 s forever', () => {
    let state = { failures: 0, stopped: false, message: '' };
    for (let tick = 0; tick < BACKUP_POLL_MAX_FAILURES; tick += 1) {
      state = decidePoll({
        failures: state.failures,
        outcome: 'transient',
        message: 'Bad gateway',
      });
    }
    expect(state.stopped).toBe(true);
    expect(state.message).toBe(BACKUP_POLL_GAVE_UP);
    expect(state.message).toMatch(/reload/i);
  });

  it('a recovered tick resets the budget, so a later blip does not trip the give-up', () => {
    const recovered = decidePoll({ failures: BACKUP_POLL_MAX_FAILURES - 1, outcome: 'ok' });
    const blip = decidePoll({ failures: recovered.failures, outcome: 'transient', message: '502' });
    expect(blip.stopped).toBe(false);
  });

  it('a terminal failure stops on the first tick and keeps its own message', () => {
    const state = decidePoll({
      failures: 0,
      outcome: 'terminal',
      message: 'Your admin access was removed. Reload the page.',
    });
    expect(state.stopped).toBe(true);
    expect(state.message).toBe('Your admin access was removed. Reload the page.');
  });

  it('the component catches its own tick and drops the "refreshes automatically" promise', () => {
    const text = source('app/(app)/admin/backups/BackupsAdmin.tsx');
    // `await response.json()` throws on a non-JSON body, on a timer.
    const refresh = text.slice(text.indexOf('const refresh'), text.indexOf('useEffect(() => {'));
    expect(refresh).toContain('try {');
    expect(refresh).toContain('} catch (cause) {');
    expect(refresh).toContain('response.json()');
    expect(refresh.indexOf('try {')).toBeLessThan(refresh.indexOf('response.json()'));
    // The interval must not restart the loop the policy just stopped.
    expect(text).toContain('if (pollStopped) return;');
    expect(text).toContain(`}, BACKUP_POLL_INTERVAL_MS);`);
    expect(BACKUP_POLL_INTERVAL_MS).toBe(2000);
    // The banner can only claim an automatic refresh while one is still running.
    const banner = text.slice(text.indexOf('(busy || data.running)'));
    expect(banner).toContain('pollStopped ? (');
    expect(banner.indexOf('pollStopped ? (')).toBeLessThan(
      banner.indexOf('This page refreshes automatically.'),
    );
  });
});

describe('F-429 templates: a refused list is not an empty gallery', () => {
  function galleryProps(tree: unknown) {
    const found = collectElements(tree).find((el) => el.type === TemplateGallery);
    expect(found).toBeDefined();
    return found!.props as { initialTemplates: unknown[]; initialError?: string };
  }

  it('a refusal reaches the gallery as a reason, not as zero templates', async () => {
    auth.getSessionUser.mockResolvedValue({ id: 'u1', role: 'MEMBER' });
    templates.listTemplates.mockResolvedValue({
      ok: false,
      error: 'Sign in required',
      status: 401,
    });

    const props = galleryProps(await TemplatesPage());

    expect(props.initialTemplates).toEqual([]);
    expect(props.initialError).toBe('Sign in required');
  });

  it('a successful load carries no error, so the empty state stays available', async () => {
    auth.getSessionUser.mockResolvedValue({ id: 'u1', role: 'MEMBER' });
    templates.listTemplates.mockResolvedValue({
      ok: true,
      data: { templates: [{ id: 't1', slug: 'saas', name: 'SaaS' }] },
    });

    const props = galleryProps(await TemplatesPage());

    expect(props.initialTemplates).toHaveLength(1);
    expect(props.initialError ?? '').toBe('');
  });

  it('the gallery renders the failure instead of the filter empty state, not both', () => {
    const text = source('components/templates/TemplateGallery.tsx');
    expect(text).toContain('initialError');
    expect(text).toContain('useState(initialError)');
    // The empty state is the `else` of the error branch: previously both could
    // render, and only the "No templates match these filters." line was visible
    // for a server load that never happened.
    expect(text).toContain(') : templates.length === 0 ? (');
    const errorBranch = text.slice(text.indexOf('{error ? ('));
    expect(errorBranch.slice(0, 400)).toContain('role="alert"');
  });
});

describe('F-428 /settings/usage: a loading page looks like it is loading', () => {
  const text = source('app/(app)/settings/usage/page.tsx');

  it('starts in the loading state and renders a skeleton for it', () => {
    expect(text).toContain('useState(true)');
    expect(text).toContain('{loading && <SkeletonLines');
  });

  it("reads the server's message instead of a fetch with no ok check", () => {
    // The old shape threw an HTML 401/500 body into a `.catch` that replaced the
    // server's explanation with a generic line.
    expect(text).not.toContain('.then((response) => response.json())');
    expect(text).toContain("fetchJson<UsageData>('/api/settings/usage')");
    expect(text).toContain('setError(toMessage(cause');
  });

  it('settles the loading flag on both outcomes', () => {
    const effect = text.slice(text.indexOf('useEffect(() => {'), text.indexOf('const reset ='));
    expect(effect).toContain('} finally {');
    expect(effect).toContain('setLoading(false)');
  });
});

describe('F-436 error boundaries report the id they tell the user to quote', () => {
  it('a crashed workspace panel reaches Sentry with its request id', () => {
    sentry.captureException.mockClear();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boundary = new PanelErrorBoundary({ children: null, label: 'Chat' });
      boundary.state = PanelErrorBoundary.getDerivedStateFromError();
      const crash = new Error('Cannot read properties of undefined');
      boundary.componentDidCatch(crash, { componentStack: '\n at Chat' });

      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      const [reported, options] = sentry.captureException.mock.calls[0] as [
        Error,
        { tags: { requestId: string; panel: string } },
      ];
      expect(reported).toBe(crash);
      // The id in Sentry has to be the id rendered by `ErrorId`, or support
      // cannot look up what the user quotes.
      expect(options.tags.requestId).toBe(boundary.state.requestId);
      expect(options.tags.requestId).toMatch(/^[0-9a-f]{12}$/);
      expect(options.tags.panel).toBe('Chat');
    } finally {
      logged.mockRestore();
    }
  });

  it('the route-level boundary reports too, not just the root-layout one', () => {
    const routeLevel = source('app/error.tsx');
    const rootLayout = source('app/global-error.tsx');
    for (const text of [routeLevel, rootLayout]) {
      expect(text).toContain("from '@sentry/nextjs'");
      expect(text).toContain('Sentry.captureException(error');
    }
    // Reported with the same id the user is asked to send to support.
    expect(routeLevel).toContain('Sentry.captureException(error, { tags: { requestId } });');
    const effect = routeLevel.slice(routeLevel.indexOf('useEffect(() => {'));
    expect(effect.indexOf('Sentry.captureException')).toBeLessThan(effect.indexOf('console.error'));
  });
});
