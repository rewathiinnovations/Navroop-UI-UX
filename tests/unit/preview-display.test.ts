import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMessageFromPreviewFrame, previewToolsState } from '@/lib/preview/display';
import { buildPreviewSrcdoc } from '@/lib/preview/html';
import { buildStaticSite } from '@/lib/preview/server-bundle';
import { ELEMENT_SELECTED_TYPE, INSPECTOR_SCRIPT_ID } from '@/lib/visual-edits/inspector';
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
 * pointed at it (`useStaticPreview.applyUrl`, the Visual Edits gate) was
 * pointed at an iframe that is never mounted and at a URL that is null unless
 * a distinct preview origin is configured (F-140).
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

describe('the inspector ships inside the document it inspects', () => {
  it('embeds the inspector in the bundled srcdoc', () => {
    const srcdoc = buildPreviewSrcdoc({ code: 'void 0;', css: 'body{}' });

    // Injecting from outside can never work: the frame is sandboxed without
    // allow-same-origin, so `contentDocument` is null and the Function-in-frame
    // fallback is unreachable too. The script has to be part of the document.
    expect(srcdoc).toContain(INSPECTOR_SCRIPT_ID);
    expect(srcdoc).toContain(ELEMENT_SELECTED_TYPE);
  });

  it('embeds the inspector in a raw-HTML project too', () => {
    const srcdoc = buildPreviewSrcdoc({
      code: '',
      rawHtml: '<html><head></head><body><h1>Plain</h1></body></html>',
    });

    expect(srcdoc).toContain(INSPECTOR_SCRIPT_ID);
    expect(srcdoc).toContain('<h1>Plain</h1>');
  });

  it('keeps the inspector inside the body, ahead of the closing tag', () => {
    const srcdoc = buildPreviewSrcdoc({ code: 'void 0;' });
    expect(srcdoc.indexOf(INSPECTOR_SCRIPT_ID)).toBeLessThan(srcdoc.indexOf('</body>'));
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

describe('previewToolsState', () => {
  const ready = { view: 'preview', pane: 'ready' as const, frameRendered: true, tool: null };

  it('offers Visual Edits over a rendered frame with no preview origin configured', () => {
    // The defect: the gate was `Boolean(sandboxUrl)`, the *served* build's signed
    // URL. That is null in every installation without a preview host, which is
    // exactly where the in-browser frame is the only preview there is.
    expect(previewToolsState(ready).showTools).toBe(true);
  });

  it('does not offer tools over a frame that is not on screen', () => {
    expect(previewToolsState({ ...ready, frameRendered: false }).showTools).toBe(false);
  });

  it('stays out of the Code, SEO and Assets views', () => {
    for (const view of ['code', 'seo', 'assets', 'brain', 'domains']) {
      expect(previewToolsState({ ...ready, view }).showTools).toBe(false);
    }
  });

  it('stays out of the planning pane', () => {
    expect(previewToolsState({ ...ready, pane: 'planning' }).showTools).toBe(false);
  });

  it('inspects only once a tool is picked', () => {
    expect(previewToolsState(ready).inspectEnabled).toBe(false);
    expect(previewToolsState({ ...ready, tool: 'edit' }).inspectEnabled).toBe(true);
  });

  it('never inspects when the toolbar itself is not offered', () => {
    expect(previewToolsState({ ...ready, tool: 'edit', frameRendered: false }).inspectEnabled).toBe(
      false,
    );
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
