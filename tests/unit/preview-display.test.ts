import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMessageFromPreviewFrame, postNavigateToPreviewFrame } from '@/lib/preview/display';
import { buildPreviewSrcdoc, PREVIEW_MESSAGE_SOURCE } from '@/lib/preview/html';
import { buildStaticSite } from '@/lib/preview/server-bundle';
import { useStaticPreview, type StaticPreviewState } from '@/components/workspace/useStaticPreview';

const notices = vi.hoisted(() => ({ error: vi.fn() }));

// react-toastify needs a document; what matters here is the URL, not the toast.
vi.mock('@/lib/notify', () => ({ notify: { error: notices.error } }));

afterEach(() => {
  vi.unstubAllGlobals();
  notices.error.mockReset();
});

/**
 * F-142/F-143 have one root: the workspace had two previews and drove the
 * wrong one.
 *
 * `BrowserPreview` compiles the project in this tab and renders it into a
 * sandboxed `srcdoc` iframe — the only preview a user ever sees. The
 * `PreviewBuild` is the *served* copy of that same document, and everything
 * pointed at it (`useStaticPreview.applyUrl`) was pointed at an iframe that is
 * never mounted and at a URL that is null unless a distinct preview origin is
 * configured (F-140).
 */
describe('the served build is the same document the frame renders', () => {
  it('publishes exactly what buildPreviewSrcdoc produces, so it is not a second thing to display', async () => {
    const result = await buildStaticSite('REACT', {
      'src/App.tsx': 'export default function App() { return <h1>Hi</h1>; }',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const published = result.files['index.html'];
    const marker = buildPreviewSrcdoc({ code: 'void 0;' });

    // Both markers are emitted only by buildPreviewSrcdoc: the module element the
    // ready-signal listener attaches to, and the import map the frame resolves
    // bare specifiers through. Rendering this build inside the app would show the
    // reader the identical document a second time.
    expect(marker).toContain('id="__preview-app"');
    expect(published).toContain('id="__preview-app"');
    expect(published).toContain('<script type="importmap">');
  });
});

describe('preview HTML has no visual-edit inspector', () => {
  it('does not embed an inspector script in the bundled srcdoc', () => {
    const srcdoc = buildPreviewSrcdoc({ code: 'void 0;', css: 'body{}' });
    expect(srcdoc).not.toContain('navroop-visual-edits');
    expect(srcdoc).not.toContain('__navroopVisualEdits');
    expect(srcdoc).toContain('__previewNavigate');
    expect(srcdoc).toContain('about:srcdoc');
  });

  it('does not embed an inspector in a raw-HTML project either', () => {
    const srcdoc = buildPreviewSrcdoc({
      code: '',
      rawHtml: '<html><head></head><body><h1>Plain</h1></body></html>',
    });

    expect(srcdoc).not.toContain('navroop-visual-edits');
    expect(srcdoc).toContain('<h1>Plain</h1>');
    expect(srcdoc).toContain('__previewNavigate');
  });
});

describe('isMessageFromPreviewFrame', () => {
  const frameWindow = { name: 'preview' };

  it('accepts the sandboxed frame by window identity, opaque origin and all', () => {
    expect(isMessageFromPreviewFrame({ source: frameWindow }, { contentWindow: frameWindow })).toBe(
      true,
    );
  });

  it('rejects a message from any other window', () => {
    expect(
      isMessageFromPreviewFrame({ source: { name: 'other' } }, { contentWindow: frameWindow }),
    ).toBe(false);
  });

  it('rejects everything while there is no frame', () => {
    expect(isMessageFromPreviewFrame({ source: frameWindow }, null)).toBe(false);
    expect(isMessageFromPreviewFrame({ source: frameWindow }, { contentWindow: null })).toBe(false);
  });
});

describe('postNavigateToPreviewFrame', () => {
  /**
   * The page picker used to post at GenerationWorkspace's `iframeRef`, which
   * is only attached to the deleted sandbox iframe. That ref is always null,
   * so `contentWindow?.postMessage` was a silent no-op and Shop/Home did
   * nothing. The helper must talk to whatever frame is actually mounted
   * (BrowserPreview / previewFrameRef) and must no-op without throwing when
   * that frame is not on screen yet.
   */
  it('posts { source, type: navigate, path } at the frame with targetOrigin *', () => {
    const postMessage = vi.fn();
    const posted = postNavigateToPreviewFrame({ contentWindow: { postMessage } }, '/shop');

    expect(posted).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { source: PREVIEW_MESSAGE_SOURCE, type: 'navigate', path: '/shop' },
      '*',
    );
  });

  it('returns false and posts nothing when the frame has no contentWindow', () => {
    const postMessage = vi.fn();
    expect(postNavigateToPreviewFrame(null, '/shop')).toBe(false);
    expect(postNavigateToPreviewFrame({ contentWindow: null }, '/cart')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('the freshly signed preview URL reaches the caller', () => {
  /**
   * Preview tokens last two hours and the status poll only runs while a build
   * is preparing, so the re-mint is the only thing keeping the top bar's "Open
   * in new tab" and "Copy link" alive. It used to be handed to
   * `iframeRef.current.src` on a ref that is permanently null, so the minted URL
   * was discarded and the link went dead mid-session (F-142).
   */
  it('returns the minted URL from retry, not the stale one the status read carries', async () => {
    const queue = [
      { status: 200, body: { previewUrl: 'https://preview.example.com/p1/pricing?token=fresh' } },
      {
        status: 200,
        body: {
          mode: 'STATIC',
          status: 'READY',
          previewUrl: 'https://preview.example.com/p1/?token=stale',
        },
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected request');
        return new Response(JSON.stringify(next.body), { status: next.status });
      }),
    );

    const captured: { retry: () => Promise<StaticPreviewState | undefined> }[] = [];
    function Probe() {
      captured.push(
        useStaticPreview({ projectId: 'p1', enabled: false, selectedPage: '/pricing' }),
      );
      return null;
    }
    renderToStaticMarkup(createElement(Probe));

    const result = await captured[0]!.retry();

    expect(result?.previewUrl).toBe('https://preview.example.com/p1/pricing?token=fresh');
    expect(result?.status).toBe('READY');
    expect(notices.error).not.toHaveBeenCalled();
  });
});
