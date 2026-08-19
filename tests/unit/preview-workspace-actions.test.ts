import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldEnterLiveMode } from '@/components/workspace/useLivePreviewMode';
import { useStaticPreview } from '@/components/workspace/useStaticPreview';

const notices = vi.hoisted(() => ({ error: vi.fn() }));

// The suite runs in the `node` environment, so react-toastify has no document to render
// into — and what matters here is which message the user is told, not how it is drawn.
vi.mock('@/lib/notify', () => ({ notify: { error: notices.error } }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const PREVIEW_ROUTE = 'app/api/projects/[id]/preview/route.ts';

/**
 * `posts: false` is a claim about the hook, not an absence of regex matches.
 *
 * `useLivePreviewMode` is the inert live-mode gate left behind when the sandbox
 * subsystem went away: it has no `fetch` at all, so the scan below finds nothing
 * in it. Without this flag that half of the loop would be silently vacuous, and
 * a reflow of the one hook that does post would make the whole case vacuous
 * while `400 Unknown action` came back.
 */
const WORKSPACE_HOOKS = [
  { file: 'components/workspace/useStaticPreview.ts', posts: true },
  { file: 'components/workspace/useLivePreviewMode.ts', posts: false },
];

/** The actions `POST /api/projects/[id]/preview` answers with anything but 400. */
function routeActions() {
  const route = source(PREVIEW_ROUTE);
  const implemented = new Set([...route.matchAll(/action === '([a-z-]+)'/g)].map((m) => m[1]));
  expect(implemented.size, 'route implements at least one action').toBeGreaterThan(0);
  return implemented;
}

/**
 * Renders a hook once through the server renderer and hands back what it
 * returned. `useState`/`useRef`/`useCallback` all work; effects do not run,
 * which is what makes this usable for a callback the user triggers by hand —
 * there is no polling to stop and no DOM to provide.
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

type RecordedCall = { url: string; method: string; body: unknown };

/** Records every request and answers them in the order the responses are queued. */
function stubFetch(responses: { status: number; body: unknown }[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request: ${String(input)}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

/**
 * The sandbox migration left the workspace posting actions the preview route no
 * longer implements: `live` and `heartbeat` every 30 seconds forever, and
 * `retry` behind a button whose response was never read. Both answered
 * `400 Unknown action`, and neither was visible to anyone but the access log.
 */
describe('workspace preview actions match the route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    notices.error.mockClear();
  });

  it('posts only actions the preview route implements', () => {
    const implemented = routeActions();

    for (const { file, posts } of WORKSPACE_HOOKS) {
      const hook = source(file);
      const posted = [...hook.matchAll(/JSON\.stringify\(\{ action: '([a-z-]+)'/g)].map(
        (match) => match[1],
      );
      if (!posts) {
        // Asserted from the other side, so "no posted actions" cannot mean "the
        // regex stopped matching": this hook talks to no route at all.
        expect(hook, `${file} posts nothing`).not.toContain('fetch(');
        expect(posted, `${file} posts nothing`).toEqual([]);
        continue;
      }
      expect(posted.length, `${file} posts at least one action`).toBeGreaterThan(0);
      for (const action of posted) {
        expect(implemented.has(action), `${file} posts action '${action}'`).toBe(true);
      }
    }
  });

  /**
   * The retry request itself, not the source line that builds it.
   *
   * The old case asserted `toContain("action: 'token', path: selectedPage")`, so
   * reformatting that literal failed the test for no behavioural reason while a
   * semantic change that kept the literal passed. What matters is the body the
   * route receives, and that the action in it is one the route implements.
   */
  it('sends "Try again" as an implemented action on the selected page', async () => {
    const calls = stubFetch([
      { status: 200, body: { previewUrl: 'https://preview.example/p/abc' } },
      {
        status: 200,
        body: { mode: 'STATIC', status: 'READY', previewUrl: 'https://preview.example/p/abc' },
      },
    ]);

    const hook = renderHookOnce(() =>
      useStaticPreview({ projectId: 'p_static', enabled: false, selectedPage: '/pricing' }),
    );
    await hook.retry();

    expect(calls[0]).toEqual({
      url: '/api/projects/p_static/preview',
      method: 'POST',
      body: { action: 'token', path: '/pricing' },
    });
    expect(routeActions().has('token')).toBe(true);
    // Retry then re-reads the build row, which is the only way a snapshot
    // captured by a later generation shows up in the panel.
    expect(calls[1]).toMatchObject({ url: '/api/projects/p_static/preview', method: 'GET' });
    expect(notices.error).not.toHaveBeenCalled();
  });

  it('surfaces a refused retry instead of re-reading the build', async () => {
    // The defect this replaces: the response was never inspected, so a rejected
    // retry was indistinguishable from a hung UI.
    const calls = stubFetch([{ status: 400, body: { error: 'Preview is not available' } }]);

    const hook = renderHookOnce(() =>
      useStaticPreview({ projectId: 'p_static', enabled: false, selectedPage: '/' }),
    );
    await hook.retry();

    expect(calls).toHaveLength(1);
    expect(notices.error).toHaveBeenCalledWith('Preview is not available', {
      fallback: 'Could not refresh the preview',
      key: 'preview-retry-p_static',
    });
  });
});

/**
 * A FAILED static build used to force live mode on, which is how a failed build
 * turned into a permanent 30-second POST against a 400 with a banner blaming the
 * user. `supported: true` here is what pins the guard: without it every case
 * would be false for the unrelated reason that no route can start live mode.
 */
describe('shouldEnterLiveMode', () => {
  it('refuses a FAILED static build even when the server says it is locked on', () => {
    expect(shouldEnterLiveMode({ lockedLive: true, staticStatus: 'FAILED', supported: true })).toBe(
      false,
    );
  });

  it('honours a server-side lock on a build that has not failed', () => {
    expect(shouldEnterLiveMode({ lockedLive: true, staticStatus: 'READY', supported: true })).toBe(
      true,
    );
    expect(shouldEnterLiveMode({ lockedLive: false, staticStatus: 'READY', supported: true })).toBe(
      false,
    );
  });

  it('never enters live mode while no route can start it', () => {
    for (const staticStatus of ['PENDING', 'BUILDING', 'READY', 'FAILED', null] as const) {
      expect(shouldEnterLiveMode({ lockedLive: true, staticStatus })).toBe(false);
    }
  });
});
