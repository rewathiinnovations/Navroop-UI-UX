import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_ACCESS_DENIED, PREVIEW_EMPTY } from '@/lib/preview/labels';
import { useStaticPreview } from '@/components/workspace/useStaticPreview';

const notices = vi.hoisted(() => ({ error: vi.fn() }));

// react-toastify needs a document, and the point here is which sentence reaches
// the user rather than how it is rendered.
vi.mock('@/lib/notify', () => ({ notify: { error: notices.error } }));

/**
 * Renders a hook once through the server renderer and hands back what it
 * returned. `useState`/`useRef`/`useCallback` all work; effects do not run,
 * which is what makes this usable for the request paths below — there is no
 * poll to stop and no DOM to provide.
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

type RecordedCall = { url: string; method: string };

/** Records every request and answers them in the order the responses are queued. */
function stubFetch(responses: { status: number; body: unknown }[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
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

function preview(projectId = 'p1') {
  return renderHookOnce(() => useStaticPreview({ projectId, enabled: true }));
}

function firstNotice() {
  expect(notices.error).toHaveBeenCalledTimes(1);
  const [message, options] = notices.error.mock.calls[0] as [unknown, { key?: string } | undefined];
  return { message, key: options?.key };
}

/**
 * `GET/POST /api/projects/[id]/preview` is owner/ADMIN only, because the signed
 * URL it mints is spendable anonymously on `/preview-static`. The hook stops
 * polling on the first 403, which is right — but on its own that left the panel
 * on PREVIEW_EMPTY ("nothing to preview yet") for a project that is fully
 * built, so a refusal was indistinguishable from a slow build. A refusal must
 * say it was refused.
 */
describe('a refused preview says so', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    notices.error.mockClear();
  });

  it('notifies on a 403 from the status read instead of silently emptying the panel', async () => {
    const calls = stubFetch([{ status: 403, body: { error: 'Forbidden' } }]);

    const state = await preview().refresh();

    expect(calls).toHaveLength(1);
    expect(state.previewUrl).toBeNull();
    expect(state.status).toBeNull();

    const { message, key } = firstNotice();
    expect(message).toBe(PREVIEW_ACCESS_DENIED);
    // Not the "nothing built yet" copy the panel falls back to, and not the
    // route's bare status word either.
    expect(message).not.toBe(PREVIEW_EMPTY);
    expect(message).not.toMatch(/^forbidden$/i);
    // Per project, so a second refusal updates this toast instead of stacking.
    expect(key).toBe('preview-denied-p1');
  });

  it('does not retry a 403, and does not repeat the notice', async () => {
    const calls = stubFetch([{ status: 403, body: { error: 'Forbidden' } }]);
    const hook = preview();

    await hook.refresh();
    await hook.refresh();
    const url = await hook.issueTokenUrl('/');

    // A second request would have thrown "unexpected request": the refusal is
    // terminal for the status read and for the 90-minute token refresher.
    expect(calls).toHaveLength(1);
    expect(url).toBeNull();
    expect(notices.error).toHaveBeenCalledTimes(1);
  });

  it('notifies when the refusal lands on the token mint first', async () => {
    const calls = stubFetch([{ status: 403, body: { error: 'Forbidden' } }]);

    const url = await preview().issueTokenUrl('/about');

    expect(url).toBeNull();
    expect(calls[0]?.method).toBe('POST');
    expect(firstNotice()).toEqual({ message: PREVIEW_ACCESS_DENIED, key: 'preview-denied-p1' });
  });

  it('stays quiet when the preview is merely not ready yet', async () => {
    stubFetch([{ status: 200, body: { status: 'BUILDING', preparing: true } }]);

    const state = await preview().refresh();

    expect(state.preparing).toBe(true);
    expect(notices.error).not.toHaveBeenCalled();
  });
});
